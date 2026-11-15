from __future__ import annotations

import hashlib
import json
import math
import re
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.orm import Session

from .content import ContentService
from .content_store import (
    ArticleVariant,
    ContentCandidate,
    ContentDatabase,
    SourcePolicyRecord,
    StoryCluster,
)
from .exam_content import EXAM_TRACKS, ExamPassage, validate_exam_passage


class ExamContentStore:
    def __init__(self, database: ContentDatabase):
        self.database = database

    @staticmethod
    def _body_hash(passage: ExamPassage) -> str:
        serialized = json.dumps(passage.paragraphs, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @staticmethod
    def _package_hash(passage: ExamPassage) -> str:
        serialized = passage.model_dump_json(by_alias=True)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @staticmethod
    def _related_id(kind: str, passage_id: str) -> str:
        return str(uuid5(NAMESPACE_URL, f"soda-reading:exam:{kind}:{passage_id}"))

    def _import_validated(self, session: Session, passage: ExamPassage) -> tuple[ArticleVariant, bool]:
        body_hash = self._body_hash(passage)
        existing = session.get(ArticleVariant, passage.id)
        if existing:
            if existing.body_hash != body_hash:
                raise ValueError(f"考试内容 {passage.id} 的 ID 相同但正文不同")
            if (existing.exam_metadata or {}).get("contentHash") != self._package_hash(passage):
                raise ValueError(f"考试内容 {passage.id} 的内容包不同，请使用新 ID 进行版本化修订")
            return existing, False

        source_id = f"exam-source-{hashlib.sha256(passage.provenance.source_id.encode('utf-8')).hexdigest()[:16]}"
        source = session.get(SourcePolicyRecord, source_id)
        if source is None:
            source = SourcePolicyRecord(
                id=source_id,
                name=passage.provenance.source_label,
                license=passage.provenance.license or "项目原创",
                crawl_allowed=False,
                full_text_allowed=True,
                attribution_required=passage.content_origin != "original",
                commercial_allowed=False,
                region="LOCAL",
                status="active",
                source_tier="B",
                source_type="editorial",
                endpoint="",
                topics=[passage.topic],
                peer_review_default="not_applicable",
                freshness_class="evergreen",
            )
            session.add(source)

        candidate_id = self._related_id("candidate", passage.id)
        candidate = ContentCandidate(
            id=candidate_id,
            source_id=source_id,
            external_id=passage.id,
            canonical_url=passage.provenance.source_url or f"local://exams/{passage.id}",
            title=passage.title,
            summary=passage.intro_zh,
            authors=[passage.author],
            source_published_at=passage.published_at,
            fetched_at=passage.source_reviewed_at,
            topic=passage.topic,
            content_kind="exam",
            peer_review_status="not_applicable",
            source_tier="B",
            license=passage.provenance.license or "项目原创",
            full_text_allowed=True,
            raw_hash=body_hash,
            title_fingerprint=hashlib.sha256(passage.title.encode("utf-8")).hexdigest(),
            quality_score=90,
            status="accepted",
            metadata_json={"examTrack": passage.exam_track, "contentOrigin": passage.content_origin},
        )
        cluster = StoryCluster(
            id=self._related_id("cluster", passage.id),
            topic=passage.topic,
            canonical_title=passage.title,
            candidate_ids=[candidate_id],
            independent_source_ids=[source_id],
            evidence_score=1,
            risk_level="low",
            status="ready",
        )
        word_count = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", " ".join(passage.paragraphs)))
        article = ArticleVariant(
            id=passage.id,
            story_cluster_id=cluster.id,
            source_candidate_id=candidate_id,
            title=passage.title,
            author=passage.author,
            summary=passage.intro_zh,
            intro_zh=passage.intro_zh,
            paragraphs=passage.paragraphs,
            sentence_translations={},
            glossary=[],
            body_hash=body_hash,
            cefr=passage.cefr,
            word_count=word_count,
            reading_minutes=max(2, math.ceil(word_count / 180)),
            topic=passage.topic,
            content_mode="original_simulation" if passage.content_origin == "original" else "licensed_exam",
            peer_review_status="not_applicable",
            quality_score=90,
            difficulty_metrics={"wordCount": word_count},
            source_published_at=passage.published_at,
            sources=[{
                "label": passage.provenance.source_label,
                "url": passage.provenance.source_url or "",
            }],
            risk_flags=[],
            review_status="approved",
            review_note="Provenance and answer review timestamps recorded in the content package.",
            exam_track=passage.exam_track,
            content_origin=passage.content_origin,
            exam_metadata={
                "year": passage.year,
                "session": passage.session,
                "region": passage.region,
                "paper": passage.paper,
                "contentHash": self._package_hash(passage),
            },
            questions=[question.model_dump(by_alias=True) for question in passage.questions],
            provenance=passage.provenance.model_dump(by_alias=True, mode="json"),
            published_at=passage.published_at,
        )
        session.add_all([candidate, cluster, article])
        session.flush()
        return article, True

    def import_passage(self, payload: dict) -> dict:
        passage = validate_exam_passage(payload)
        with self.database.session() as session:
            article, _ = self._import_validated(session, passage)
            return ContentService._article_dict(article, 0)

    def import_passages(self, payloads: list[dict]) -> dict:
        passages = [validate_exam_passage(payload) for payload in payloads]
        with self.database.session() as session:
            imported = [self._import_validated(session, passage) for passage in passages]
            return {
                "added": sum(created for _, created in imported),
                "items": [ContentService._article_dict(article, 0) for article, _ in imported],
            }

    def list(self, track: str | None = None) -> list[dict]:
        if track is not None and track not in EXAM_TRACKS:
            raise ValueError("未知考试轨道")
        with self.database.session() as session:
            statement = select(ArticleVariant).where(
                ArticleVariant.exam_track.is_not(None),
                ArticleVariant.review_status == "approved",
            )
            if track:
                statement = statement.where(ArticleVariant.exam_track == track)
            articles = session.scalars(statement.order_by(ArticleVariant.exam_track, ArticleVariant.title)).all()
            return [ContentService._article_dict(article, 0) for article in articles]
