from __future__ import annotations

import asyncio
import hashlib
import math
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from sqlalchemy import delete, inspect, or_, select, text

from .content_editorial import EditorialGateway, EditorialUnavailable, LEVEL_TARGETS
from .content_sources import (
    LANGUAGE_IDENTIFIER,
    SOURCE_POLICIES,
    TOPICS,
    RawCandidate,
    build_adapters,
)
from .text_excerpt import (
    NAV_SKIP,
    cjk_char_count,
    drop_title_duplicate,
    is_low_quality_source,
    select_reading_excerpt,
    word_count,
)
from .content_store import (
    ArticleVariant,
    ContentCandidate,
    ContentDatabase,
    DailyEdition,
    FactClaim,
    PipelineRun,
    SourceFetchState,
    SourcePolicyRecord,
    StoryCluster,
    utc_now,
)
from .settings import Settings


COMMON_ENGLISH_WORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "on", "by", "from",
    "is", "are", "was", "were", "this", "that", "study", "research", "new", "people",
}
FRESHNESS_DAYS = {"news": 90, "paper": 90, "evergreen": 365, "literature": 73000}
FAST_SOURCE_IDS = {
    "nasa-rss",
    "the-conversation-atom",
    "wikipedia-featured",
    "zhwiki-featured",
    "gutenberg-popular",
}
RISK_WORDS = {
    "treatment", "cure", "vaccine", "drug", "therapy", "mortality", "cancer", "diagnosis",
    "causes", "guarantees", "proves",
}


def canonicalize_url(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in {"ref", "source", "campaign"}
    ]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), urlencode(query), ""))


def normalized_title(title: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", title.lower()).strip()


def title_tokens(title: str) -> set[str]:
    return {token for token in normalized_title(title).split() if len(token) > 2 and token not in COMMON_ENGLISH_WORDS}


def title_similarity(first: str, second: str) -> float:
    left, right = title_tokens(first), title_tokens(second)
    if not left or not right:
        return 0
    return len(left & right) / len(left | right)


def title_fingerprint(title: str) -> str:
    return hashlib.sha256(normalized_title(title).encode()).hexdigest()


def raw_hash(candidate: RawCandidate) -> str:
    return hashlib.sha256(
        f"{candidate.title}|{candidate.summary}|{canonicalize_url(candidate.url)}".encode()
    ).hexdigest()


def simhash64(text: str) -> str:
    tokens = re.findall(r"\b[a-z0-9][a-z0-9'-]*\b", text.lower())
    if not tokens:
        return "0" * 16
    features = Counter(tokens)
    vector = [0] * 64
    for token, weight in features.items():
        hashed = int.from_bytes(hashlib.blake2b(token.encode(), digest_size=8).digest(), "big")
        for bit in range(64):
            vector[bit] += weight if hashed & (1 << bit) else -weight
    value = sum(1 << bit for bit, score in enumerate(vector) if score >= 0)
    return f"{value:016x}"


def simhash_distance(first: str, second: str) -> int:
    try:
        return (int(first, 16) ^ int(second, 16)).bit_count()
    except (TypeError, ValueError):
        return 64


def corroboration_counts(candidates: list[RawCandidate]) -> dict[str, int]:
    fingerprints: dict[str, list[str]] = defaultdict(list)
    for candidate in candidates:
        title_key = title_fingerprint(candidate.title)
        content_fingerprint = simhash64(f"{candidate.title} {candidate.summary}")
        if not any(
            simhash_distance(content_fingerprint, existing) <= 3
            for existing in fingerprints[title_key]
        ):
            fingerprints[title_key].append(content_fingerprint)
    return {title_key: len(items) for title_key, items in fingerprints.items()}


def is_probably_english(text: str) -> bool:
    letters = re.findall(r"[A-Za-z]", text)
    non_ascii_letters = re.findall(r"[^\x00-\x7F]", text)
    words = re.findall(r"\b[a-z]+\b", text.lower())
    if len(letters) < 15 or len(non_ascii_letters) > max(20, len(letters) * 0.3):
        return False
    common_hits = sum(word in COMMON_ENGLISH_WORDS for word in words)
    if common_hits < 2 and len(words) < 8:
        return False
    language, probability = LANGUAGE_IDENTIFIER.classify(text[:5000])
    return language == "en" and probability >= 0.8


def is_probably_english_title(title: str) -> bool:
    if re.search(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", title):
        return False
    ascii_letters = re.findall(r"[A-Za-z]", title)
    non_ascii_letters = re.findall(r"[^\W\d_]", title, flags=re.UNICODE)
    non_ascii_count = sum(not letter.isascii() for letter in non_ascii_letters)
    words = re.findall(r"\b[a-z]+\b", title.lower())
    if len(ascii_letters) < 12 or non_ascii_count > max(3, len(ascii_letters) * 0.08):
        return False
    language, probability = LANGUAGE_IDENTIFIER.classify(title[:1000])
    common_hits = sum(word in COMMON_ENGLISH_WORDS for word in words)
    return (language == "en" and probability >= 0.55) or common_hits >= 2


def has_sufficient_evidence_text(summary: str) -> bool:
    words = re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", summary)
    return len(words) >= 18 and len(summary.strip()) >= 100


def is_chinese_source(candidate: RawCandidate) -> bool:
    metadata = candidate.metadata or {}
    return metadata.get("sourceLanguage") == "zh" or candidate.source_id == "zhwiki-featured"


def has_sufficient_chinese_text(summary: str) -> bool:
    return cjk_char_count(summary) >= 40 and len((summary or "").strip()) >= 80


def candidate_age_days(candidate: RawCandidate, now: datetime) -> int:
    published = candidate.published_at
    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    return max(0, (now - published.astimezone(timezone.utc)).days)


def validate_candidate(candidate: RawCandidate, now: datetime) -> list[str]:
    reasons = []
    if not candidate.title or len(candidate.title) < 12:
        reasons.append("missing_or_short_title")
    if not candidate.url.startswith(("http://", "https://")):
        reasons.append("invalid_url")
    if is_chinese_source(candidate):
        if cjk_char_count(candidate.title) < 4 and cjk_char_count(candidate.summary) < 24:
            reasons.append("not_chinese_source_text")
        if not has_sufficient_chinese_text(candidate.summary):
            reasons.append("insufficient_evidence_text")
    else:
        if not is_probably_english_title(candidate.title):
            reasons.append("not_english_title")
        if not is_probably_english(candidate.summary):
            reasons.append("not_english_summary")
        if not has_sufficient_evidence_text(candidate.summary):
            reasons.append("insufficient_evidence_text")
    max_age = FRESHNESS_DAYS.get(candidate.content_kind, 30)
    if candidate_age_days(candidate, now) > max_age:
        reasons.append(f"older_than_{max_age}_days")
    if candidate.published_at > now + timedelta(days=1):
        reasons.append("future_publication_date")
    if is_low_quality_source(candidate.title, candidate.url, (candidate.metadata or {}).get("paragraphs") or []):
        reasons.append("low_quality_index_or_chrome")
    if not candidate.license:
        reasons.append("unknown_license")
    return reasons


def candidate_quality(candidate: RawCandidate, corroboration_count: int, now: datetime) -> float:
    source_score = {"A": 30, "B": 24, "C": 18}.get(candidate.source_tier, 15)
    primary_score = 25 if candidate.source_tier == "A" or candidate.content_kind == "paper" else 18
    maximum_age = FRESHNESS_DAYS.get(candidate.content_kind, 30)
    freshness_score = max(0, 20 * (1 - candidate_age_days(candidate, now) / maximum_age))
    corroboration_score = 15 if corroboration_count >= 2 else (5 if candidate.source_tier == "A" else 0)
    completeness_score = 4
    completeness_score += 3 if len(candidate.summary) >= 100 else 0
    completeness_score += 2 if candidate.authors else 0
    completeness_score += 1 if candidate.doi else 0
    return round(source_score + primary_score + freshness_score + corroboration_score + completeness_score, 2)


def excerpt_coherence(paragraphs: list[str]) -> tuple[bool, list[str]]:
    reasons = []
    cleaned = [re.sub(r"\s+", " ", paragraph).strip() for paragraph in paragraphs if paragraph.strip()]
    if len(cleaned) < 3:
        reasons.append("needs_at_least_three_paragraphs")
        return False, reasons
    opening = cleaned[0]
    if re.match(r"^(however|therefore|but|and|this|these|they|it|such)\b", opening, re.IGNORECASE):
        reasons.append("opening_depends_on_missing_context")
    if not re.search(r"[.!?][\"']?$", cleaned[-1]):
        reasons.append("ending_is_not_closed")
    if cleaned[-1].endswith((",", ":", ";", "—", "-")):
        reasons.append("ending_is_incomplete")
    joined = " ".join(cleaned)
    if len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", joined)) < 120:
        reasons.append("excerpt_too_short_for_complete_logic")
    return not reasons, reasons


def difficulty_metrics(paragraphs: list[str]) -> dict[str, Any]:
    text = " ".join(paragraphs)
    words = re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", text)
    sentences = [part for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    sentence_lengths = [len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", sentence)) for sentence in sentences]
    complex_markers = len(re.findall(
        r"\b(although|because|while|whereas|which|that|despite|however|therefore|unless|whose)\b",
        text,
        flags=re.IGNORECASE,
    ))
    named_entities = len(re.findall(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b", text))
    long_words = sum(len(word) >= 8 for word in words)
    metrics = {
        "wordCount": len(words),
        "sentenceCount": len(sentences),
        "averageSentenceLength": round(sum(sentence_lengths) / max(1, len(sentence_lengths)), 2),
        "complexMarkerDensity": round(complex_markers / max(1, len(sentences)), 3),
        "properNounDensity": round(named_entities / max(1, len(words)), 3),
        "longWordDensity": round(long_words / max(1, len(words)), 3),
    }
    sentence_length = metrics["averageSentenceLength"]
    complexity = metrics["complexMarkerDensity"]
    long_density = metrics["longWordDensity"]
    if sentence_length <= 13 and complexity <= 0.25 and long_density <= 0.12:
        estimated = "A2"
    elif sentence_length <= 18 and complexity <= 0.55 and long_density <= 0.18:
        estimated = "B1"
    elif sentence_length <= 24 and complexity <= 0.9 and long_density <= 0.24:
        estimated = "B2"
    else:
        estimated = "C1"
    metrics["estimatedCefr"] = estimated
    return metrics


class ContentPipeline:
    def __init__(self, settings: Settings, database: ContentDatabase):
        self.settings = settings
        self.database = database
        self.adapters = build_adapters(settings, database)
        self.editorial = EditorialGateway(settings)

    def initialize(self) -> None:
        self.database.initialize()
        with self.database.session() as session:
            current_policy_ids = {policy.id for policy in SOURCE_POLICIES}
            for existing in session.scalars(select(SourcePolicyRecord)):
                if existing.id not in current_policy_ids:
                    existing.status = "retired"
                    existing.crawl_allowed = False
            for policy in SOURCE_POLICIES:
                record = session.get(SourcePolicyRecord, policy.id) or SourcePolicyRecord(id=policy.id)
                record.name = policy.name
                record.license = policy.license
                record.crawl_allowed = policy.crawlAllowed
                record.full_text_allowed = policy.fullTextAllowed
                record.attribution_required = policy.attributionRequired
                record.commercial_allowed = policy.commercialAllowed
                record.region = policy.region
                record.status = policy.status
                record.source_tier = policy.sourceTier
                record.source_type = policy.sourceType
                record.endpoint = policy.endpoint
                record.topics = policy.topics
                record.peer_review_default = policy.peerReviewDefault
                record.freshness_class = policy.freshnessClass
                session.add(record)

    async def run(self, limit: int | None = None, generate: bool = False, publish: bool = False) -> dict:
        requested = max(1, min(limit or self.settings.content_discovery_min, self.settings.content_discovery_max))
        run = PipelineRun(requested_limit=requested, kind="full" if generate else "discovery")
        with self.database.session() as session:
            session.add(run)
            session.flush()
            run_id = run.id

        try:
            raw, source_stats = await self._discover(requested)
            accepted_ids, stats, coverage = self._filter_and_store(raw, run_id)
            clusters = self._cluster(accepted_ids)
            generated_count = await self._generate(clusters) if generate else 0
            if generate:
                await self._backfill_intro_zh()
            target_date = (
                datetime.now(ZoneInfo(self.settings.content_timezone)).date()
                + timedelta(days=self.settings.content_publish_offset_days)
            )
            published_count = self.publish_today(target_date) if publish else 0
            self.cleanup_retention()
            with self.database.session() as session:
                stored = session.get(PipelineRun, run_id)
                stored.status = "completed"
                stored.fetched_count = len(raw)
                stored.accepted_count = stats["accepted"]
                stored.duplicate_count = stats["duplicates"]
                stored.rejected_count = stats["rejected"]
                stored.generated_count = generated_count
                stored.published_count = published_count
                stored.source_stats = source_stats
                stored.topic_coverage = coverage
                stored.finished_at = utc_now()
            return self.get_run(run_id)
        except Exception as error:
            with self.database.session() as session:
                stored = session.get(PipelineRun, run_id)
                stored.status = "failed"
                stored.error = f"{type(error).__name__}: {str(error)[:1000]}"
                stored.finished_at = utc_now()
            raise

    async def _discover(self, requested: int) -> tuple[list[RawCandidate], dict]:
        if not self.adapters:
            return [], {}

        candidates: list[RawCandidate] = []
        source_stats: dict[str, dict] = {
            adapter.policy.id: {"status": "pending", "fetched": 0, "requests": 0}
            for adapter in self.adapters
        }
        offsets: Counter[str] = Counter()
        seen: set[tuple[str, str]] = set()
        now = datetime.now(timezone.utc)
        with self.database.session() as session:
            health_states = {
                state.source_id: state
                for state in session.scalars(select(SourceFetchState))
            }
        production_run = requested >= self.settings.content_discovery_min
        maximum = self.settings.content_discovery_max if production_run else requested
        missing_topics = set(TOPICS)
        next_batch = requested

        round_index = 0
        while len(candidates) < maximum and next_batch > 0:
            eligible = [
                adapter
                for adapter in self.adapters
                if not missing_topics or missing_topics.intersection(adapter.policy.topics)
            ]
            if not production_run:
                licensed = [adapter for adapter in eligible if getattr(adapter.policy, "fullTextAllowed", False)]
                if licensed:
                    eligible = licensed
                fast = [adapter for adapter in eligible if getattr(adapter.policy, "id", "") in FAST_SOURCE_IDS]
                if fast:
                    eligible = fast
            if round_index > 0:
                eligible = [
                    adapter
                    for adapter in eligible
                    if (
                        adapter.policy.id not in health_states
                        or health_states[adapter.policy.id].health_score >= 0.35
                    )
                    and not (
                        adapter.policy.id in health_states
                        and health_states[adapter.policy.id].fetched_count >= 100
                        and health_states[adapter.policy.id].accepted_count
                        / max(1, health_states[adapter.policy.id].fetched_count)
                        < 0.05
                    )
                ]
            if not eligible:
                break
            per_source = max(
                2 if not production_run else 5,
                min(6 if not production_run else 200, math.ceil(next_batch / len(eligible))),
            )
            results = await asyncio.gather(
                *(
                    adapter.fetch(per_source, offsets[adapter.policy.id])
                    for adapter in eligible
                ),
                return_exceptions=True,
            )
            new_count = 0
            for adapter, result in zip(eligible, results):
                stats = source_stats[adapter.policy.id]
                stats["requests"] += 1
                offsets[adapter.policy.id] += per_source
                if isinstance(result, Exception):
                    stats.update(
                        status="failed",
                        error=f"{type(result).__name__}: {str(result)[:250]}",
                    )
                    continue
                stats["status"] = "ok"
                stats["fetched"] += len(result)
                adapter.client.record_count(adapter.policy.id, len(result))
                for item in result:
                    identity = (item.source_id, item.external_id or raw_hash(item))
                    if identity in seen:
                        continue
                    seen.add(identity)
                    candidates.append(item)
                    new_count += 1
                    if len(candidates) >= maximum:
                        break

            preliminary = Counter()
            corroboration = corroboration_counts(candidates)
            for item in candidates:
                if (
                    not validate_candidate(item, now)
                    and candidate_quality(item, corroboration[title_fingerprint(item.title)], now) >= 65
                ):
                    preliminary[item.topic] += 1
            missing_topics = {topic for topic in TOPICS if preliminary[topic] < 5}
            if (
                not production_run
                or (len(candidates) >= requested and not missing_topics)
                or len(candidates) >= maximum
            ):
                break
            if new_count == 0:
                break
            next_batch = min(maximum - len(candidates), max(250, requested // 2))
            round_index += 1

        return candidates[:maximum], source_stats

    def _filter_and_store(self, raw: list[RawCandidate], run_id: str) -> tuple[list[str], dict, dict]:
        now = datetime.now(timezone.utc)
        corroboration = corroboration_counts(raw)
        by_source: Counter[str] = Counter()
        by_topic: Counter[str] = Counter()
        accepted_ids: list[str] = []
        stats = {"accepted": 0, "duplicates": 0, "rejected": 0}
        accepted_by_source: Counter[str] = Counter()
        duplicates_by_source: Counter[str] = Counter()
        source_cap = max(1, math.ceil(len(raw) * 0.25))
        topic_cap = max(1, math.ceil(len(raw) * 0.30))

        ranked = sorted(
            raw,
            key=lambda item: candidate_quality(item, corroboration[title_fingerprint(item.title)], now),
            reverse=True,
        )
        with self.database.session() as session:
            policy_full_text = {
                policy.id: policy.full_text_allowed
                for policy in session.scalars(select(SourcePolicyRecord))
            }
            for item in ranked:
                reasons = validate_candidate(item, now)
                if by_source[item.source_id] >= source_cap:
                    reasons.append("source_share_above_25_percent")
                if by_topic[item.topic] >= topic_cap:
                    reasons.append("topic_share_above_30_percent")
                quality = candidate_quality(item, corroboration[title_fingerprint(item.title)], now)
                canonical_url = canonicalize_url(item.url)
                existing = session.scalar(
                    select(ContentCandidate).where(
                        or_(
                            (ContentCandidate.source_id == item.source_id)
                            & (ContentCandidate.external_id == item.external_id),
                            (ContentCandidate.source_id == item.source_id)
                            & (ContentCandidate.title_fingerprint == title_fingerprint(item.title)),
                            (ContentCandidate.doi != "") & (ContentCandidate.doi == item.doi) if item.doi else False,
                            ContentCandidate.raw_hash == raw_hash(item),
                        )
                    ).limit(1)
                )
                if existing:
                    stats["duplicates"] += 1
                    duplicates_by_source[item.source_id] += 1
                    continue
                status = "rejected" if reasons or quality < 65 else ("accepted" if quality >= 75 else "review")
                record = ContentCandidate(
                    source_id=item.source_id,
                    external_id=item.external_id,
                    doi=item.doi,
                    canonical_url=canonical_url,
                    title=item.title,
                    summary=item.summary,
                    authors=item.authors,
                    source_published_at=item.published_at,
                    topic=item.topic,
                    content_kind=item.content_kind,
                    peer_review_status=item.peer_review_status,
                    source_tier=item.source_tier,
                    license=item.license,
                    full_text_allowed=bool(
                        item.full_text_allowed and policy_full_text.get(item.source_id, False)
                    ),
                    raw_hash=raw_hash(item),
                    title_fingerprint=title_fingerprint(item.title),
                    quality_score=quality,
                    status=status,
                    rejection_reason=",".join(reasons) if reasons else ("quality_below_75" if quality < 75 else ""),
                    metadata_json={
                        **item.metadata,
                        "pipelineRunId": run_id,
                        "contentSimhash": simhash64(f"{item.title} {item.summary}"),
                    },
                )
                session.add(record)
                session.flush()
                if status == "accepted":
                    accepted_ids.append(record.id)
                    by_source[item.source_id] += 1
                    by_topic[item.topic] += 1
                    accepted_by_source[item.source_id] += 1
                    stats["accepted"] += 1
                elif status == "rejected":
                    stats["rejected"] += 1
        if self.adapters:
            client = self.adapters[0].client
            for source_id in {item.source_id for item in raw}:
                client.record_count(
                    source_id,
                    fetched=0,
                    accepted=accepted_by_source[source_id],
                    duplicates=duplicates_by_source[source_id],
                    evaluated=True,
                )
        pool_coverage: Counter[str] = Counter()
        with self.database.session() as session:
            for candidate in session.scalars(
                select(ContentCandidate).where(ContentCandidate.status == "accepted")
            ):
                published = candidate.source_published_at
                if published.tzinfo is None:
                    published = published.replace(tzinfo=timezone.utc)
                if (now - published.astimezone(timezone.utc)).days <= FRESHNESS_DAYS.get(
                    candidate.content_kind, 30
                ):
                    pool_coverage[candidate.topic] += 1
        coverage = {topic: pool_coverage[topic] for topic in TOPICS}
        return accepted_ids, stats, coverage

    def _cluster(self, candidate_ids: list[str]) -> list[str]:
        if not candidate_ids:
            return []
        with self.database.session() as session:
            candidates = list(session.scalars(
                select(ContentCandidate).where(ContentCandidate.id.in_(candidate_ids))
                .order_by(ContentCandidate.quality_score.desc())
            ))
            groups: list[list[ContentCandidate]] = []
            for candidate in candidates:
                match = next(
                    (
                        group
                        for group in groups
                        if candidate.doi and any(item.doi == candidate.doi for item in group)
                        or title_similarity(candidate.title, group[0].title) >= 0.55
                    ),
                    None,
                )
                if match is None:
                    groups.append([candidate])
                else:
                    match.append(candidate)
            cluster_ids = []
            for group in groups:
                source_ids = []
                independent_fingerprints: list[str] = []
                for item in group:
                    fingerprint = item.metadata_json.get("contentSimhash", "")
                    if any(simhash_distance(fingerprint, existing) <= 3 for existing in independent_fingerprints):
                        continue
                    independent_fingerprints.append(fingerprint)
                    source_ids.append(item.source_id)
                source_ids = list(dict.fromkeys(source_ids))
                risk_flags = self._risk_flags(group)
                cluster = StoryCluster(
                    topic=group[0].topic,
                    canonical_title=group[0].title,
                    candidate_ids=[item.id for item in group],
                    independent_source_ids=source_ids,
                    evidence_score=round(sum(item.quality_score for item in group) / len(group), 2),
                    risk_level="high" if risk_flags else "low",
                    status="review" if risk_flags else "ready",
                )
                session.add(cluster)
                session.flush()
                for item in group:
                    claim_text = (item.summary.split(". ")[0] if item.summary else item.title)[:600]
                    session.add(FactClaim(
                        story_cluster_id=cluster.id,
                        claim=claim_text,
                        source_url=item.canonical_url,
                        source_label=item.source_id,
                        evidence_locator="abstract/metadata",
                        verified=item.source_tier == "A" and item.peer_review_status != "preprint",
                    ))
                cluster_ids.append(cluster.id)
            return cluster_ids

    @staticmethod
    def _risk_flags(candidates: list[ContentCandidate]) -> list[str]:
        flags = []
        if any(item.peer_review_status == "preprint" for item in candidates):
            flags.append("preprint")
        text = " ".join(f"{item.title} {item.summary}" for item in candidates).lower()
        if any(re.search(rf"\b{re.escape(word)}\b", text) for word in RISK_WORDS):
            flags.append("health_or_causal_claim")
        if len({item.source_id for item in candidates}) < 2 and candidates[0].source_tier != "A":
            flags.append("single_non_primary_source")
        return flags

    def active_cefr_levels(self) -> list[str]:
        configured = self.settings.configured_cefr_levels
        try:
            if inspect(self.database.engine).has_table("profiles"):
                with self.database.session() as session:
                    active = {
                        str(level).upper()
                        for level in session.execute(
                            text(
                                "select distinct cefr from profiles "
                                "where is_active = true and cefr in ('A2','B1','B2','C1')"
                            )
                        ).scalars()
                    }
                selected = [level for level in configured if level in active]
                if selected:
                    return selected
        except Exception:
            # The local SQLite preview intentionally has no account schema.
            pass
        return configured

    async def _generate(self, cluster_ids: list[str]) -> int:
        generated = await self._materialize_original_articles(cluster_ids)
        if generated >= self.settings.content_max_daily_variants:
            return generated
        if generated >= 3 and self.settings.content_prefer_original:
            return generated
        return generated + await self._generate_editorial(cluster_ids, already=generated)

    async def _materialize_original_articles(self, cluster_ids: list[str]) -> int:
        if not cluster_ids:
            return 0
        generated = 0
        pending: list[ArticleVariant] = []
        per_source_cap = 3
        zh_jobs: list[tuple[StoryCluster, ContentCandidate, list[str]]] = []
        with self.database.session() as session:
            clusters = list(session.scalars(
                select(StoryCluster).where(StoryCluster.id.in_(cluster_ids))
                .order_by(StoryCluster.evidence_score.desc())
            ))
            existing = {
                row[0]
                for row in session.execute(
                    select(ArticleVariant.source_candidate_id).where(
                        ArticleVariant.source_candidate_id.in_(
                            [candidate_id for cluster in clusters for candidate_id in cluster.candidate_ids]
                        )
                    )
                ).all()
            }
            source_counts: Counter[str] = Counter()
            deferred: list[tuple[StoryCluster, ContentCandidate]] = []

            def queue_candidate(cluster: StoryCluster, candidate: ContentCandidate) -> bool:
                nonlocal generated
                stored_paragraphs = list((candidate.metadata_json or {}).get("paragraphs") or [])
                chinese = (
                    (candidate.metadata_json or {}).get("sourceLanguage") == "zh"
                    or candidate.source_id == "zhwiki-featured"
                )
                if chinese:
                    paragraphs = [item for item in stored_paragraphs if str(item).strip()]
                    if len(paragraphs) < 3 or cjk_char_count("".join(paragraphs)) < 120:
                        return False
                    zh_jobs.append((cluster, candidate, paragraphs[:8]))
                    existing.add(candidate.id)
                    source_counts[candidate.source_id] += 1
                    generated += 1
                    return True
                paragraphs = (
                    stored_paragraphs
                    if len(stored_paragraphs) >= 3 and word_count(stored_paragraphs) >= 120
                    else select_reading_excerpt(stored_paragraphs)
                )
                paragraphs = drop_title_duplicate(paragraphs, candidate.title)
                paragraphs = [paragraph for paragraph in paragraphs if not NAV_SKIP.search(paragraph)]
                if len(paragraphs) < 3 or is_low_quality_source(
                    candidate.title, candidate.canonical_url, paragraphs
                ):
                    return False
                article = self._article_from_original(cluster, candidate, paragraphs)
                session.add(article)
                pending.append(article)
                existing.add(candidate.id)
                source_counts[candidate.source_id] += 1
                generated += 1
                return True

            for cluster in clusters:
                if generated >= self.settings.content_max_daily_variants:
                    break
                for candidate_id in cluster.candidate_ids:
                    if candidate_id in existing:
                        continue
                    candidate = session.get(ContentCandidate, candidate_id)
                    if not candidate or not candidate.full_text_allowed:
                        continue
                    if source_counts[candidate.source_id] >= per_source_cap:
                        deferred.append((cluster, candidate))
                        continue
                    if queue_candidate(cluster, candidate):
                        break
            for cluster, candidate in deferred:
                if generated >= self.settings.content_max_daily_variants:
                    break
                if candidate.id in existing:
                    continue
                queue_candidate(cluster, candidate)
            if zh_jobs:
                translations = await asyncio.gather(*[
                    self._english_from_chinese_safe(candidate.title, candidate.topic or cluster.topic, paragraphs)
                    for cluster, candidate, paragraphs in zh_jobs
                ])
                for (cluster, candidate, _source), result in zip(zh_jobs, translations):
                    if not result:
                        generated -= 1
                        existing.discard(candidate.id)
                        continue
                    article = self._article_from_original(cluster, candidate, result["paragraphs"])
                    article.title = result["title"]
                    article.intro_zh = result["introZh"]
                    article.summary = result["introZh"][:500]
                    article.content_mode = "translated_from_zh"
                    session.add(article)
                    pending.append(article)
            need_intro = [article for article in pending if not (article.intro_zh or "").strip()]
            if need_intro:
                intros = await asyncio.gather(*[
                    self.editorial.intro_zh(
                        title=article.title,
                        source=(article.sources or [{}])[0].get("label", "原文"),
                        topic=article.topic,
                        paragraphs=article.paragraphs,
                    )
                    for article in need_intro
                ])
                for article, intro in zip(need_intro, intros):
                    article.intro_zh = intro
                    if intro:
                        article.summary = intro[:500]
        return generated

    async def _english_from_chinese_safe(
        self,
        title: str,
        topic: str,
        paragraphs: list[str],
    ) -> dict | None:
        try:
            return await self.editorial.english_from_chinese(
                title=title,
                topic=topic,
                paragraphs=paragraphs,
            )
        except EditorialUnavailable:
            return None

    async def _backfill_intro_zh(self) -> None:
        with self.database.session() as session:
            articles = [
                article for article in session.scalars(
                    select(ArticleVariant).where(
                        or_(ArticleVariant.intro_zh == "", ArticleVariant.intro_zh.is_(None))
                    )
                )
                if not is_low_quality_source(
                    article.title,
                    ((article.sources or [{}])[0] or {}).get("url", ""),
                    article.paragraphs,
                )
            ][:12]
            if not articles:
                return
            intros = await asyncio.gather(*[
                self.editorial.intro_zh(
                    title=article.title,
                    source=(article.sources or [{}])[0].get("label", "原文"),
                    topic=article.topic,
                    paragraphs=article.paragraphs or [],
                )
                for article in articles
            ])
            for article, intro in zip(articles, intros):
                article.intro_zh = intro
                if intro and (
                    not article.summary
                    or not re.search(r"[\u3400-\u9fff]", article.summary)
                ):
                    article.summary = intro[:500]

    async def _generate_editorial(self, cluster_ids: list[str], already: int = 0) -> int:
        if not cluster_ids:
            return 0
        levels = self.active_cefr_levels()
        story_limit = min(6, max(3, self.settings.content_max_daily_variants // len(levels)))
        selected: list[StoryCluster] = []
        with self.database.session() as session:
            clusters = list(session.scalars(
                select(StoryCluster).where(
                    StoryCluster.id.in_(cluster_ids),
                    StoryCluster.status == "ready",
                    StoryCluster.risk_level == "low",
                )
                .order_by(StoryCluster.evidence_score.desc())
            ))
            seen_topics = set()
            for cluster in clusters:
                if cluster.topic not in seen_topics:
                    selected.append(cluster)
                    seen_topics.add(cluster.topic)
                if len(selected) >= story_limit:
                    break
            if len(selected) < story_limit:
                selected_ids = {cluster.id for cluster in selected}
                selected.extend(
                    cluster for cluster in clusters
                    if cluster.id not in selected_ids
                )
                selected = selected[:story_limit]
            selected_ids = [cluster.id for cluster in selected]
            existing_pairs = set(session.execute(
                select(ArticleVariant.story_cluster_id, ArticleVariant.cefr).where(
                    ArticleVariant.story_cluster_id.in_(selected_ids)
                )
            ).all()) if selected_ids else set()
            for cluster in selected:
                session.expunge(cluster)
        generated = 0
        for cluster in selected:
            evidence, cluster = self._evidence_for_cluster(cluster.id)
            for level in levels:
                if already + generated >= self.settings.content_max_daily_variants:
                    return generated
                if (cluster.id, level) in existing_pairs:
                    continue
                try:
                    result = await self.editorial.generate(cluster.topic, level, evidence)
                except EditorialUnavailable:
                    break
                article = self._article_from_result(cluster, evidence, level, result)
                with self.database.session() as session:
                    session.add(article)
                    for claim in result.get("factClaims", []):
                        for evidence_index in claim["evidenceIndexes"]:
                            source = evidence[evidence_index]
                            session.add(FactClaim(
                                story_cluster_id=cluster.id,
                                claim=claim["sentence"],
                                source_url=source["url"],
                                source_label=source["source"],
                                evidence_locator=f"editorial-claim:evidence[{evidence_index}]",
                                verified=True,
                            ))
                generated += 1
        return generated

    async def generate_ready(self) -> int:
        with self.database.session() as session:
            clusters = list(session.scalars(
                select(StoryCluster)
                .where(
                    StoryCluster.status == "ready",
                    StoryCluster.risk_level == "low",
                )
                .order_by(StoryCluster.evidence_score.desc(), StoryCluster.created_at.desc())
                .limit(self.settings.content_target_clusters)
            ))
            cluster_ids = [cluster.id for cluster in clusters]
        return await self._generate(cluster_ids)

    def audit_state(self) -> dict:
        revalidated = self.revalidate_candidates()
        with self.database.session() as session:
            candidates = list(session.scalars(select(ContentCandidate.status)))
            clusters = list(session.scalars(select(StoryCluster.status)))
            reviews = list(session.scalars(select(ArticleVariant.review_status)))
        return {
            "candidateStatus": dict(Counter(candidates)),
            "clusterStatus": dict(Counter(clusters)),
            "articleStatus": dict(Counter(reviews)),
            "paidProvidersEnabled": self.settings.paid_provider_enabled,
            "dailyPaidBudgetCny": self.settings.daily_paid_budget_cny,
            "revalidatedRejectedCount": revalidated,
        }

    def revalidate_candidates(self) -> int:
        now = datetime.now(timezone.utc)
        changed = 0
        with self.database.session() as session:
            candidates = list(session.scalars(
                select(ContentCandidate).where(ContentCandidate.status != "rejected")
            ))
            for candidate in candidates:
                reasons = []
                if not is_probably_english_title(candidate.title):
                    reasons.append("not_english_title")
                if not is_probably_english(candidate.summary):
                    reasons.append("not_english_summary")
                if not has_sufficient_evidence_text(candidate.summary):
                    reasons.append("insufficient_evidence_text")
                maximum_age = FRESHNESS_DAYS.get(candidate.content_kind, 30)
                published = candidate.source_published_at
                if published.tzinfo is None:
                    published = published.replace(tzinfo=timezone.utc)
                age_days = max(0, (now - published.astimezone(timezone.utc)).days)
                if age_days > maximum_age:
                    reasons.append(f"older_than_{maximum_age}_days")
                if published > now + timedelta(days=1):
                    reasons.append("future_publication_date")
                if not candidate.license:
                    reasons.append("unknown_license")
                if reasons:
                    candidate.status = "rejected"
                    candidate.rejection_reason = ",".join(reasons)
                    changed += 1
            if changed:
                status_by_id = {
                    candidate.id: candidate.status
                    for candidate in session.scalars(select(ContentCandidate))
                }
                for cluster in session.scalars(select(StoryCluster)):
                    if cluster.candidate_ids and all(
                        status_by_id.get(candidate_id) == "rejected"
                        for candidate_id in cluster.candidate_ids
                    ):
                        cluster.status = "rejected"
        return changed

    def _evidence_for_cluster(self, cluster_id: str) -> tuple[list[dict], StoryCluster]:
        with self.database.session() as session:
            cluster = session.get(StoryCluster, cluster_id)
            candidates = list(session.scalars(
                select(ContentCandidate).where(ContentCandidate.id.in_(cluster.candidate_ids))
                .order_by(ContentCandidate.quality_score.desc())
            ))
            evidence = []
            evidence_fingerprints: list[str] = []
            for item in candidates:
                fingerprint = item.metadata_json.get("contentSimhash", "")
                if any(simhash_distance(fingerprint, existing) <= 3 for existing in evidence_fingerprints):
                    continue
                evidence_fingerprints.append(fingerprint)
                evidence.append({
                    "title": item.title,
                    "summary": item.summary,
                    "publishedAt": item.source_published_at.isoformat(),
                    "source": item.source_id,
                    "url": item.canonical_url,
                    "peerReviewStatus": item.peer_review_status,
                })
            session.expunge(cluster)
            return evidence, cluster

    def _article_from_result(
        self,
        cluster: StoryCluster,
        evidence: list[dict],
        level: str,
        result: dict,
    ) -> ArticleVariant:
        metrics = difficulty_metrics(result["paragraphs"])
        coherent, coherence_reasons = excerpt_coherence(result["paragraphs"])
        risk_flags = []
        if cluster.risk_level == "high":
            risk_flags.append("cluster_requires_review")
        risk_flags.extend(coherence_reasons)
        source_quality = min(25, cluster.evidence_score / 4)
        traceability = 25 if evidence and result.get("factClaims") else (18 if evidence else 0)
        coherence = 20 if coherent else 8
        minimum, maximum, _ = LEVEL_TARGETS[level]
        level_distance = abs(
            ["A2", "B1", "B2", "C1"].index(level)
            - ["A2", "B1", "B2", "C1"].index(metrics["estimatedCefr"])
        )
        language = (
            20
            if minimum <= result["wordCount"] <= maximum and level_distance == 0
            else 16
            if minimum <= result["wordCount"] <= maximum and level_distance == 1
            else 8
        )
        if level_distance > 1:
            risk_flags.append("cefr_metric_mismatch")
        quality = round(source_quality + traceability + coherence + language + 10, 2)
        auto_approved = (
            self.settings.content_auto_publish
            and quality >= 85
            and not risk_flags
            and all(item["peerReviewStatus"] != "preprint" for item in evidence)
        )
        body_hash = hashlib.sha256("\n\n".join(result["paragraphs"]).encode()).hexdigest()
        source_date = max(datetime.fromisoformat(item["publishedAt"]) for item in evidence)
        return ArticleVariant(
            story_cluster_id=cluster.id,
            source_candidate_id=cluster.candidate_ids[0],
            title=result["title"],
            summary=result["summary"],
            intro_zh=result["summary"],
            paragraphs=result["paragraphs"],
            sentence_translations=result.get("sentenceTranslations", {}),
            glossary=result.get("glossary", []),
            body_hash=body_hash,
            cefr=level,
            word_count=result["wordCount"],
            reading_minutes=max(2, math.ceil(result["wordCount"] / 180)),
            topic=cluster.topic,
            content_mode="editorial_digest",
            peer_review_status=(
                "preprint" if any(item["peerReviewStatus"] == "preprint" for item in evidence)
                else "peer_reviewed" if any(item["peerReviewStatus"] == "peer_reviewed" for item in evidence)
                else "not_applicable"
            ),
            quality_score=quality,
            difficulty_metrics=metrics,
            source_published_at=source_date,
            sources=[
                {"label": item["source"], "url": item["url"], "publishedAt": item["publishedAt"]}
                for item in evidence
            ],
            risk_flags=risk_flags,
            review_status="approved" if auto_approved else "review",
        )

    def _article_from_original(
        self,
        cluster: StoryCluster,
        candidate: ContentCandidate,
        paragraphs: list[str],
    ) -> ArticleVariant:
        metrics = difficulty_metrics(paragraphs)
        coherent, coherence_reasons = excerpt_coherence(paragraphs)
        count = word_count(paragraphs)
        level = metrics["estimatedCefr"]
        quality = round(
            (30 if candidate.source_tier == "A" else 24)
            + 25
            + (20 if coherent else 8)
            + 18,
            2,
        )
        risk_flags = list(coherence_reasons)
        blocking = {"excerpt_too_short_for_complete_logic", "needs_at_least_three_paragraphs"}
        auto_approved = (
            self.settings.content_auto_publish
            and quality >= 85
            and candidate.source_tier == "A"
            and not (set(risk_flags) & blocking)
        )
        source_name = next(
            (policy.name for policy in SOURCE_POLICIES if policy.id == candidate.source_id),
            candidate.source_id,
        )
        return ArticleVariant(
            story_cluster_id=cluster.id,
            source_candidate_id=candidate.id,
            title=candidate.title,
            author=(candidate.authors or ["Unknown"])[0][:200],
            summary=(candidate.summary or paragraphs[0])[:500],
            intro_zh="",
            paragraphs=paragraphs,
            sentence_translations={},
            glossary=[],
            body_hash=hashlib.sha256("\n\n".join(paragraphs).encode()).hexdigest(),
            cefr=level,
            word_count=count,
            reading_minutes=max(2, math.ceil(count / 180)),
            topic=candidate.topic or cluster.topic,
            content_mode="original_excerpt",
            peer_review_status=candidate.peer_review_status,
            quality_score=quality,
            difficulty_metrics=metrics,
            source_published_at=candidate.source_published_at,
            sources=[{
                "label": source_name,
                "url": candidate.canonical_url,
                "publishedAt": candidate.source_published_at.isoformat(),
            }],
            risk_flags=risk_flags,
            review_status="approved" if auto_approved else "review",
        )

    def publish_today(self, target_date: date | None = None) -> int:
        local_date = target_date or datetime.now(ZoneInfo(self.settings.content_timezone)).date()
        active_levels = self.active_cefr_levels()
        story_limit = min(
            6,
            max(3, self.settings.content_max_daily_variants // len(active_levels)),
        )
        target_count = min(8, max(6, story_limit))
        with self.database.session() as session:
            articles = [
                article for article in session.scalars(
                    select(ArticleVariant)
                    .where(
                        ArticleVariant.review_status == "approved",
                        ArticleVariant.cefr.in_(active_levels),
                        ArticleVariant.quality_score >= 85,
                    )
                    .order_by(ArticleVariant.created_at.desc(), ArticleVariant.quality_score.desc())
                )
                if not is_low_quality_source(
                    article.title,
                    ((article.sources or [{}])[0] or {}).get("url", ""),
                    article.paragraphs,
                )
            ]
            recent_editions = list(session.scalars(
                select(DailyEdition).where(
                    DailyEdition.edition_date < local_date,
                    DailyEdition.edition_date >= local_date - timedelta(days=7),
                    DailyEdition.status == "published",
                )
            ))
            recent_article_ids = {
                article_id
                for edition in recent_editions
                for article_id in (edition.article_ids or [])
            }
            by_cluster: dict[str, dict[str, ArticleVariant]] = defaultdict(dict)
            for article in articles:
                by_cluster[article.story_cluster_id].setdefault(article.cefr, article)
            complete_clusters = [
                variants
                for variants in by_cluster.values()
                if all(level in variants for level in active_levels)
            ]
            complete_clusters.sort(
                key=lambda variants: (
                    all(item.id not in recent_article_ids for item in variants.values()),
                    max(item.created_at for item in variants.values()),
                    sum(item.quality_score for item in variants.values()) / len(variants),
                ),
                reverse=True,
            )
            chosen_clusters: list[dict[str, ArticleVariant]] = []
            seen_topics: set[str] = set()
            for variants in complete_clusters:
                topic = next(iter(variants.values())).topic
                if topic not in seen_topics:
                    chosen_clusters.append(variants)
                    seen_topics.add(topic)
                if len(chosen_clusters) >= story_limit:
                    break
            if len(chosen_clusters) < story_limit:
                selected_cluster_ids = {
                    next(iter(variants.values())).story_cluster_id
                    for variants in chosen_clusters
                }
                chosen_clusters.extend(
                    variants for variants in complete_clusters
                    if next(iter(variants.values())).story_cluster_id not in selected_cluster_ids
                )
                chosen_clusters = chosen_clusters[:story_limit]
            selected_articles = [
                variants[level]
                for variants in chosen_clusters
                for level in active_levels
            ][:self.settings.content_max_daily_variants]
            originals = [
                article for article in articles
                if article.content_mode == "original_excerpt"
            ]
            if originals:
                def source_label(article: ArticleVariant) -> str:
                    return str(((article.sources or [{}])[0] or {}).get("label", ""))

                unique_keep: list[ArticleVariant] = []
                extras: list[ArticleVariant] = []
                seen_clusters: set[str] = set()
                for article in selected_articles:
                    if article.story_cluster_id in seen_clusters:
                        extras.append(article)
                        continue
                    seen_clusters.add(article.story_cluster_id)
                    unique_keep.append(article)
                mixed = list(unique_keep)
                used_ids = {article.id for article in mixed}
                label_counts: Counter[str] = Counter(source_label(article) for article in mixed)
                has_non_book = any("gutenberg" not in source_label(article).lower() for article in originals)
                def published_stamp(article: ArticleVariant) -> int:
                    value = article.source_published_at or article.created_at
                    if value is None:
                        return 0
                    try:
                        return int(value.timestamp())
                    except (OSError, OverflowError, ValueError):
                        return value.toordinal()

                ranked_originals = sorted(
                    originals,
                    key=lambda article: (
                        1 if article.id in recent_article_ids else 0,
                        2 if "gutenberg" in source_label(article).lower() else (
                            1 if "wikipedia" in source_label(article).lower() else 0
                        ),
                        -published_stamp(article),
                    ),
                )
                for article in ranked_originals:
                    if article.id in used_ids or article.story_cluster_id in seen_clusters:
                        continue
                    label = source_label(article)
                    book = "gutenberg" in label.lower()
                    if book and has_non_book and label_counts[label] >= 3:
                        continue
                    if not book and label_counts[label] >= 3:
                        continue
                    mixed.append(article)
                    seen_clusters.add(article.story_cluster_id)
                    used_ids.add(article.id)
                    label_counts[label] += 1
                    if len(mixed) >= target_count:
                        break
                if len(mixed) < target_count:
                    for article in [*extras, *articles]:
                        if article.id in used_ids:
                            continue
                        mixed.append(article)
                        used_ids.add(article.id)
                        if len(mixed) >= target_count:
                            break
                selected_articles = mixed[: self.settings.content_max_daily_variants]
            elif len(selected_articles) < 3:
                picked: list[ArticleVariant] = []
                used_topics: set[str] = {article.topic for article in selected_articles}
                used_ids = {article.id for article in selected_articles}
                for article in articles:
                    if article.id in used_ids or article.id in recent_article_ids:
                        continue
                    if article.topic in used_topics and len(picked) + len(selected_articles) >= target_count:
                        continue
                    picked.append(article)
                    used_topics.add(article.topic)
                    used_ids.add(article.id)
                    if len(selected_articles) + len(picked) >= target_count:
                        break
                selected_articles = [*selected_articles, *picked][: self.settings.content_max_daily_variants]
            if len(selected_articles) < 3:
                extra = [
                    article for article in articles
                    if article.id not in {item.id for item in selected_articles}
                ]
                selected_articles = [*selected_articles, *extra][: max(3, len(selected_articles))]
            if len(selected_articles) < 3:
                return 0
            edition = session.get(DailyEdition, local_date) or DailyEdition(edition_date=local_date)
            edition.article_ids = [article.id for article in selected_articles]
            edition.coverage = {
                "topics": {
                    topic: sum(1 for article in selected_articles if article.topic == topic)
                    for topic in TOPICS
                },
                "levels": {
                    level: sum(1 for article in selected_articles if article.cefr == level)
                    for level in active_levels
                },
                "stories": len({article.story_cluster_id for article in selected_articles}),
                "variants": len(selected_articles),
            }
            edition.status = "published"
            edition.published_at = utc_now()
            for article in selected_articles:
                article.published_at = edition.published_at
            session.add(edition)
            return len(edition.article_ids)

    def cleanup_retention(self) -> dict[str, int]:
        now = datetime.now(timezone.utc)
        with self.database.session() as session:
            protected_candidate_ids = set(session.scalars(select(ArticleVariant.source_candidate_id)))
            rejected = session.execute(
                delete(ContentCandidate).where(
                    ContentCandidate.status == "rejected",
                    ContentCandidate.fetched_at < now - timedelta(days=14),
                    ContentCandidate.id.not_in(protected_candidate_ids),
                )
            ).rowcount or 0
            metadata = session.execute(
                delete(ContentCandidate).where(
                    ContentCandidate.status != "rejected",
                    ContentCandidate.fetched_at < now - timedelta(days=90),
                    ContentCandidate.id.not_in(protected_candidate_ids),
                )
            ).rowcount or 0
            runs = session.execute(
                delete(PipelineRun).where(
                    PipelineRun.started_at < now - timedelta(days=90)
                )
            ).rowcount or 0
        return {"rejectedCandidates": rejected, "metadataCandidates": metadata, "pipelineRuns": runs}

    def get_run(self, run_id: str) -> dict:
        with self.database.session() as session:
            run = session.get(PipelineRun, run_id)
            if not run:
                raise KeyError(run_id)
            return self.serialize_run(run)

    def list_runs(self, limit: int = 20) -> list[dict]:
        with self.database.session() as session:
            return [
                self.serialize_run(run)
                for run in session.scalars(
                    select(PipelineRun).order_by(PipelineRun.started_at.desc()).limit(limit)
                )
            ]

    def list_candidates(self, status: str | None = None, limit: int = 100) -> list[dict]:
        query = select(ContentCandidate).order_by(
            ContentCandidate.quality_score.desc(), ContentCandidate.fetched_at.desc()
        ).limit(limit)
        if status:
            query = query.where(ContentCandidate.status == status)
        with self.database.session() as session:
            return [self.serialize_candidate(item) for item in session.scalars(query)]

    def list_articles(self, status: str | None = None, limit: int = 100) -> list[dict]:
        query = select(ArticleVariant).order_by(
            ArticleVariant.quality_score.desc(), ArticleVariant.created_at.desc()
        ).limit(limit)
        if status:
            query = query.where(ArticleVariant.review_status == status)
        with self.database.session() as session:
            return [self.serialize_article(item) for item in session.scalars(query)]

    def review_article(self, article_id: str, decision: str, note: str = "") -> dict:
        with self.database.session() as session:
            article = session.get(ArticleVariant, article_id)
            if not article:
                raise KeyError(article_id)
            article.review_status = decision
            article.review_note = note
            return self.serialize_article(article)

    @staticmethod
    def serialize_run(run: PipelineRun) -> dict:
        return {
            "id": run.id,
            "kind": run.kind,
            "status": run.status,
            "requestedLimit": run.requested_limit,
            "fetchedCount": run.fetched_count,
            "acceptedCount": run.accepted_count,
            "duplicateCount": run.duplicate_count,
            "rejectedCount": run.rejected_count,
            "reviewCount": max(
                0,
                run.fetched_count
                - run.accepted_count
                - run.duplicate_count
                - run.rejected_count,
            ),
            "generatedCount": run.generated_count,
            "publishedCount": run.published_count,
            "sourceStats": run.source_stats,
            "topicCoverage": run.topic_coverage,
            "error": run.error,
            "startedAt": run.started_at.isoformat(),
            "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
        }

    @staticmethod
    def serialize_candidate(item: ContentCandidate) -> dict:
        return {
            "id": item.id,
            "sourceId": item.source_id,
            "externalId": item.external_id,
            "doi": item.doi,
            "title": item.title,
            "summary": item.summary,
            "url": item.canonical_url,
            "publishedAt": item.source_published_at.isoformat(),
            "topic": item.topic,
            "contentKind": item.content_kind,
            "peerReviewStatus": item.peer_review_status,
            "sourceTier": item.source_tier,
            "qualityScore": item.quality_score,
            "status": item.status,
            "rejectionReason": item.rejection_reason,
            "fullTextAllowed": item.full_text_allowed,
        }

    @staticmethod
    def serialize_article(article: ArticleVariant) -> dict:
        return {
            "id": article.id,
            "title": article.title,
            "cefr": article.cefr,
            "topic": article.topic,
            "qualityScore": article.quality_score,
            "reviewStatus": article.review_status,
            "riskFlags": article.risk_flags,
            "reviewNote": article.review_note,
            "summary": article.summary,
            "sources": article.sources,
            "createdAt": article.created_at.isoformat(),
        }
