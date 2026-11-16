from __future__ import annotations

import asyncio
import hashlib
import math
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .content import ContentService
from .content_editorial import LEVEL_TARGETS, EditorialUnavailable
from .content_pipeline import difficulty_metrics
from .content_store import (
    ArticleVariant,
    ContentCandidate,
    ContentDatabase,
    DailyArticleRecord,
    FactClaim,
    SourcePolicyRecord,
    StoryCluster,
)
from .schemas import DailyArticleRequest


def daily_article_word_range(level: str, length: str) -> tuple[int, int]:
    if level not in LEVEL_TARGETS or length not in {"short", "medium", "long"}:
        raise ValueError("Unsupported daily article level or length")
    minimum, maximum, _ = LEVEL_TARGETS[level]
    step = max(10, round(((maximum - minimum) / 3) / 10) * 10)
    lower = minimum + step
    upper = minimum + step * 2
    ranges = {
        "short": (minimum, lower),
        "medium": (lower, upper),
        "long": (upper, maximum),
    }
    return ranges[length]


class DailyArticleEvidenceUnavailable(RuntimeError):
    pass


class DailyArticleCefrMismatch(RuntimeError):
    pass


class DailyArticleStore:
    def __init__(self, database: ContentDatabase, gateway, clock=None):
        self.database = database
        self.gateway = gateway
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._lock = asyncio.Lock()

    def _now(self) -> datetime:
        value = self._clock()
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    def _day(self):
        timezone_name = getattr(self.database.settings, "content_timezone", "Asia/Shanghai")
        return self._now().astimezone(ZoneInfo(timezone_name)).date()

    @staticmethod
    def _aware(value: datetime) -> datetime:
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    def _expire_stale(self, session, record: DailyArticleRecord | None) -> None:
        if record is None or record.status != "generating":
            return
        timeout_ms = getattr(self.gateway.settings, "editorial_total_timeout_ms", 75000)
        stale_before = self._now().timestamp() - (timeout_ms / 1000 + 30)
        if self._aware(record.updated_at).timestamp() < stale_before:
            record.status = "failed"
            record.error = "GENERATION_INTERRUPTED"
            record.updated_at = self._now()

    def _response(self, record: DailyArticleRecord | None, session) -> dict:
        day = self._day()
        if record is None:
            return {"date": day.isoformat(), "status": "empty", "request": None, "article": None, "error": None}
        article = session.get(ArticleVariant, record.article_id) if record.article_id else None
        return {
            "date": record.generation_date.isoformat(),
            "status": record.status,
            "request": dict(record.request_json or {}),
            "article": ContentService._article_dict(article, 100) if article else None,
            "error": record.error or None,
        }

    def today(self, user_id: str = "local-user") -> dict:
        with self.database.session() as session:
            record = session.get(DailyArticleRecord, (user_id, self._day()))
            self._expire_stale(session, record)
            return self._response(record, session)

    def history(self, user_id: str = "local-user") -> list[dict]:
        with self.database.session() as session:
            articles = list(session.scalars(
                select(ArticleVariant)
                .join(DailyArticleRecord, DailyArticleRecord.article_id == ArticleVariant.id)
                .where(
                    DailyArticleRecord.user_id == user_id,
                    DailyArticleRecord.status == "ready",
                )
                .order_by(DailyArticleRecord.generation_date.desc())
            ))
            return [ContentService._article_dict(article, 100) for article in articles]

    def evidence_for(self, interest: str) -> list[dict]:
        with self.database.session() as session:
            rows = session.execute(
                select(ContentCandidate, SourcePolicyRecord)
                .join(SourcePolicyRecord, ContentCandidate.source_id == SourcePolicyRecord.id)
                .where(
                    ContentCandidate.topic == interest,
                    ContentCandidate.status == "accepted",
                    ContentCandidate.content_kind != "exam",
                    ContentCandidate.quality_score >= 75,
                    ContentCandidate.license != "",
                    ContentCandidate.peer_review_status != "preprint",
                    ContentCandidate.source_tier.in_(("A", "B")),
                    SourcePolicyRecord.status == "active",
                    SourcePolicyRecord.crawl_allowed.is_(True),
                    SourcePolicyRecord.license != "",
                )
                .order_by(
                    ContentCandidate.quality_score.desc(),
                    ContentCandidate.source_published_at.desc(),
                    ContentCandidate.id,
                )
                .limit(40)
            ).all()
            evidence = []
            seen_sources = set()
            for candidate, policy in rows:
                if candidate.source_id in seen_sources or not candidate.canonical_url.startswith("https://"):
                    continue
                summary = re.sub(r"\s+", " ", candidate.summary or "").strip()
                paragraphs = list((candidate.metadata_json or {}).get("paragraphs") or [])
                full_text_allowed = candidate.full_text_allowed and policy.full_text_allowed
                excerpt = "\n\n".join(
                    re.sub(r"\s+", " ", str(paragraph)).strip()
                    for paragraph in paragraphs[:3]
                    if str(paragraph).strip()
                )[:1200] if full_text_allowed else ""
                bounded = summary[:1200]
                if excerpt:
                    bounded = f"{bounded}\n\n{excerpt}"[:2400] if bounded else excerpt
                if len(bounded) < 80:
                    continue
                seen_sources.add(candidate.source_id)
                evidence.append({
                    "candidateId": candidate.id,
                    "sourceId": candidate.source_id,
                    "title": candidate.title[:300],
                    "summary": bounded,
                    "publishedAt": self._aware(candidate.source_published_at).isoformat(),
                    "source": policy.name,
                    "url": candidate.canonical_url,
                    "peerReviewStatus": candidate.peer_review_status,
                })
                if len(evidence) >= 4:
                    break
            return evidence if len(evidence) >= 3 else []

    async def generate(self, request, user_id: str = "local-user") -> dict:
        payload = request if isinstance(request, DailyArticleRequest) else DailyArticleRequest(**request)
        async with self._lock:
            existing = self.today(user_id)
            if existing["status"] != "empty":
                return existing
            day = self._day()
            try:
                with self.database.session() as session:
                    record = session.get(DailyArticleRecord, (user_id, day))
                    if record is not None:
                        self._expire_stale(session, record)
                        return self._response(record, session)
                    session.add(DailyArticleRecord(
                        user_id=user_id,
                        generation_date=day,
                        status="generating",
                        request_json=payload.model_dump(),
                        created_at=self._now(),
                        updated_at=self._now(),
                    ))
                    session.flush()
            except IntegrityError:
                return self.today(user_id)

            try:
                evidence = self.evidence_for(payload.interest)
                if len(evidence) < 3:
                    raise DailyArticleEvidenceUnavailable
                result = await self.gateway.generate(
                    payload.interest,
                    payload.cefr,
                    evidence,
                    form=payload.form,
                    word_range=daily_article_word_range(payload.cefr, payload.length),
                )
                return self._save_success(user_id, day, payload, evidence, result)
            except asyncio.CancelledError:
                self._fail(user_id, day, "GENERATION_CANCELLED")
                raise
            except DailyArticleEvidenceUnavailable:
                self._fail(user_id, day, "INSUFFICIENT_EVIDENCE")
            except DailyArticleCefrMismatch:
                self._fail(user_id, day, "CEFR_MISMATCH")
            except EditorialUnavailable:
                self._fail(user_id, day, "MODEL_UNAVAILABLE")
            except (asyncio.TimeoutError, TimeoutError):
                self._fail(user_id, day, "GENERATION_TIMEOUT")
            except Exception:
                self._fail(user_id, day, "GENERATION_FAILED")
            return self.today(user_id)

    def _fail(self, user_id: str, generation_day, code: str) -> None:
        with self.database.session() as session:
            record = session.get(DailyArticleRecord, (user_id, generation_day))
            if record is not None and record.status == "generating":
                record.status = "failed"
                record.error = code
                record.updated_at = self._now()

    def _save_success(self, user_id: str, generation_day, request: DailyArticleRequest, evidence: list[dict], result: dict) -> dict:
        now = self._now()
        day = generation_day
        article_id = str(uuid5(NAMESPACE_URL, f"soda-reading:daily-ai:{user_id}:{day}"))
        cluster_id = str(uuid5(NAMESPACE_URL, f"soda-reading:daily-ai-cluster:{user_id}:{day}"))
        body_hash = hashlib.sha256("\n\n".join(result["paragraphs"]).encode()).hexdigest()
        metrics = difficulty_metrics(result["paragraphs"])
        level_order = list(LEVEL_TARGETS)
        level_distance = abs(level_order.index(request.cefr) - level_order.index(metrics["estimatedCefr"]))
        if level_distance > 1:
            raise DailyArticleCefrMismatch
        quality_score = 90 - level_distance * 5
        source_date = max(
            datetime.fromisoformat(str(item["publishedAt"]).replace("Z", "+00:00"))
            for item in evidence
        )
        with self.database.session() as session:
            record = session.get(DailyArticleRecord, (user_id, day))
            if record is None or record.status != "generating":
                raise ValueError("Daily generation reservation is missing")
            session.add(StoryCluster(
                id=cluster_id,
                topic=request.interest,
                canonical_title=result["title"],
                candidate_ids=[item["candidateId"] for item in evidence],
                independent_source_ids=[item["sourceId"] for item in evidence],
                evidence_score=len(evidence),
                risk_level="low",
                status="ready",
                created_at=now,
            ))
            session.add(ArticleVariant(
                id=article_id,
                story_cluster_id=cluster_id,
                source_candidate_id=evidence[0]["candidateId"],
                title=result["title"],
                summary=result["summary"],
                intro_zh=result["summary"],
                paragraphs=result["paragraphs"],
                sentence_translations=result.get("sentenceTranslations") or {},
                glossary=result.get("glossary") or [],
                body_hash=body_hash,
                cefr=request.cefr,
                word_count=result["wordCount"],
                reading_minutes=max(2, math.ceil(result["wordCount"] / 180)),
                topic=request.interest,
                content_mode="daily_ai",
                content_origin="original",
                peer_review_status=(
                    "peer_reviewed" if any(item["peerReviewStatus"] == "peer_reviewed" for item in evidence)
                    else "not_applicable"
                ),
                quality_score=quality_score,
                difficulty_metrics=metrics,
                source_published_at=source_date,
                sources=[{
                    "label": item["source"],
                    "url": item["url"],
                    "publishedAt": item["publishedAt"],
                } for item in evidence],
                risk_flags=[],
                review_status="approved",
                provenance={
                    "dailyArticle": True,
                    "form": request.form,
                    "length": request.length,
                    "generatedAt": now.isoformat(),
                    "factClaims": result.get("factClaims") or [],
                },
                created_at=now,
                published_at=now,
            ))
            for claim in result.get("factClaims") or []:
                for evidence_index in claim["evidenceIndexes"]:
                    source = evidence[evidence_index]
                    session.add(FactClaim(
                        story_cluster_id=cluster_id,
                        claim=claim["sentence"],
                        source_url=source["url"],
                        source_label=source["source"],
                        evidence_locator=f"daily-ai:evidence[{evidence_index}]",
                        verified=False,
                    ))
            record.status = "ready"
            record.article_id = article_id
            record.error = ""
            record.updated_at = now
            session.flush()
            return self._response(record, session)
