import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import inspect, select, text

from app.content_moderation import ContentModerationGateway, moderate_candidate_rules
from app.content_pipeline import ContentPipeline
from app.content_sources import RawCandidate, TOPICS
from app.content_store import ContentCandidate, ContentDatabase, PipelineRun
from app.model_center import ModelCenterStore
from app.settings import Settings


def make_candidate(
    external_id: str,
    *,
    source_id: str = "crossref-api",
    topic: str = "科技",
    source_tier: str = "A",
    days_old: int = 1,
) -> RawCandidate:
    return RawCandidate(
        source_id=source_id,
        external_id=external_id,
        title="A careful report explains a public issue",
        url=f"https://example.org/{external_id}",
        published_at=datetime.now(timezone.utc) - timedelta(days=days_old),
        summary=(
            "The report explains the available evidence, competing interpretations, "
            "methodological limits, and why readers should examine the original material."
        ),
        authors=["Editorial Team"],
        topic=topic,
        content_kind="paper",
        peer_review_status="peer_reviewed",
        license="metadata indexing allowed",
        source_tier=source_tier,
    )


@pytest.fixture
def pipeline(tmp_path):
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'moderation.db'}",
        content_discovery_min=10,
        content_discovery_max=20,
        editorial_provider_order="",
        paid_provider_enabled=False,
    )
    database = ContentDatabase(settings)
    instance = ContentPipeline(settings, database)
    instance.initialize()
    return instance


def test_moderation_does_not_reject_serious_criticism_for_tone():
    candidate = make_candidate("serious")
    candidate.title = "A serious criticism of the current public policy"
    candidate.summary = (
        "The author criticizes the policy and presents a controversial argument about its "
        "unequal effects. The article considers contrary evidence, uncertainty, and possible "
        "reforms without offering hatred, explicit material, or dangerous instructions."
    )

    decision = moderate_candidate_rules(candidate)

    assert decision.blocking_reasons == []
    assert decision.review_reasons == []


@pytest.mark.parametrize(
    ("title", "summary", "reason"),
    [
        (
            "Why people of this race are inferior and should be hated",
            "This hateful attack calls for exclusion and demeans a protected group with enough text for review.",
            "hate_or_harassment",
        ),
        (
            "Explicit sex video for adults",
            "This pornographic description contains explicit sexual material rather than an educational reading article.",
            "explicit_content",
        ),
        (
            "How to build a weapon to hurt people at school",
            "These step by step instructions explain how to make an explosive device and cause serious injury.",
            "dangerous_instruction",
        ),
        (
            "You won't believe this shocking secret",
            "This sensational headline promises a secret that will change your life forever without reliable evidence.",
            "sensational_clickbait",
        ),
    ],
)
def test_moderation_has_stable_blocking_reasons(title, summary, reason):
    candidate = make_candidate(reason)
    candidate.title = title
    candidate.summary = summary

    decision = moderate_candidate_rules(candidate)

    assert reason in decision.blocking_reasons


def test_moderation_health_guarantee_requires_semantic_review():
    candidate = make_candidate("health-claim")
    candidate.title = "Researchers examine a treatment that guarantees a cure"
    candidate.summary = (
        "The article claims that this treatment guarantees a cure for every cancer and "
        "urges readers to stop taking their prescribed medicine without consulting a doctor."
    )

    decision = moderate_candidate_rules(candidate)

    assert decision.blocking_reasons == []
    assert "health_claim_requires_review" in decision.review_reasons


@pytest.mark.asyncio
async def test_moderation_pipeline_preserves_review_and_records_reasons(pipeline):
    class FakeClient:
        def record_count(self, *_args, **_kwargs):
            return None

    class FakeAdapter:
        policy = SimpleNamespace(id="crossref-api", topics=TOPICS, fullTextAllowed=False)
        client = FakeClient()

        async def fetch(self, _limit, _offset=0):
            candidate = make_candidate("dangerous")
            candidate.title = "How to build a weapon to hurt people at school"
            candidate.summary = (
                "These step by step instructions explain how to make an explosive device "
                "and cause serious injury rather than providing a safe educational article."
            )
            return [candidate]

    pipeline.adapters = [FakeAdapter()]
    result = await pipeline.run(limit=1, generate=False, publish=False)

    assert result["rejectedCount"] == 1
    assert result["moderationStats"]["ruleRejected"] == 1
    assert result["moderationStats"]["reasons"] == {"dangerous_instruction": 1}
    assert result["moderationStats"]["aiAccepted"] == 0
    assert result["moderationStats"]["aiRejected"] == 0
    assert result["moderationStats"]["aiSkipped"] == 0
    assert result["duplicateRate"] == 0


def test_moderation_duplicate_rate_uses_fetched_candidates():
    run = PipelineRun(
        fetched_count=10,
        accepted_count=0,
        duplicate_count=2,
        rejected_count=0,
        started_at=datetime.now(timezone.utc),
        edition_coverage={"tracks": {"general": 3, "high_school": 2}},
    )

    serialized = ContentPipeline.serialize_run(run)

    assert serialized["duplicateRate"] == 0.2
    assert serialized["editionCoverage"]["tracks"] == {"general": 3, "high_school": 2}


def test_moderation_database_upgrade_adds_stats_column(tmp_path):
    path = tmp_path / "old-content.db"
    settings = Settings(database_url=f"sqlite:///{path}")
    database = ContentDatabase(settings)
    with database.engine.begin() as connection:
        connection.execute(text("CREATE TABLE pipeline_runs (id VARCHAR(36) PRIMARY KEY)"))

    database.initialize()
    database.initialize()

    columns = {column["name"] for column in inspect(database.engine).get_columns("pipeline_runs")}
    assert {"moderation_stats", "edition_coverage"} <= columns


@pytest.mark.asyncio
async def test_moderation_gateway_uses_task_route_and_bounds_input(monkeypatch):
    route_calls = []
    monkeypatch.setattr(
        "app.content_moderation.task_provider_order",
        lambda task, _settings, _overrides: route_calls.append(task) or ["zhipu"],
    )
    gateway = ContentModerationGateway(
        Settings(zhipu_api_key="test-free-key", paid_provider_enabled=False),
        store=ModelCenterStore(),
    )
    candidate = make_candidate("bounded-input")
    candidate.summary = "evidence " * 400
    candidate.metadata = {
        "paragraphs": ["Full article text must never be sent."],
        "moderation": {"ruleReviewReasons": ["health_claim_requires_review"]},
    }
    captured = {}

    async def fake_post(_provider, body):
        captured.update(body)
        return {
            "choices": [{"message": {"content": '{"decision":"approve","confidence":0.93,"reasons":[]}'}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 8},
        }

    gateway._post = fake_post
    result = await gateway.moderate(candidate)

    assert route_calls == ["content_moderation"]
    assert result["decision"] == "approve"
    assert result["confidence"] == 0.93
    assert result["provider"] == "zhipu"
    sent = json.loads(captured["messages"][1]["content"])
    assert len(sent["summary"]) <= 1200
    assert "paragraphs" not in sent
    assert "Full article text" not in json.dumps(captured)
    assert sent["riskFlags"] == ["health_claim_requires_review"]
    assert gateway.store.usage_summary()["content_moderation"]["successes"] == 1


@pytest.mark.asyncio
async def test_moderation_zero_budget_never_calls_paid_provider():
    gateway = ContentModerationGateway(
        Settings(
            deepseek_api_key="test-paid-key",
            editorial_provider_order="deepseek",
            paid_provider_enabled=False,
            daily_paid_budget_cny=0,
        ),
        store=ModelCenterStore(),
    )
    calls = []

    async def forbidden_post(*_args):
        calls.append(1)
        return {}

    gateway._post = forbidden_post
    result = await gateway.moderate(make_candidate("zero-budget"))

    assert calls == []
    assert result["decision"] == "reject"
    assert result["reasons"] == ["moderation_unavailable"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        {"decision": "approve", "confidence": 0.84, "reasons": []},
        {"decision": "reject", "confidence": 0.96, "reasons": ["unsupported_claim"]},
    ],
)
async def test_moderation_low_confidence_and_rejection_stay_unpublished(response):
    gateway = ContentModerationGateway(
        Settings(zhipu_api_key="test-free-key"),
        store=ModelCenterStore(),
    )

    async def fake_post(*_args):
        return {"choices": [{"message": {"content": json.dumps(response)}}]}

    gateway._post = fake_post
    result = await gateway.moderate(make_candidate(response["decision"]))

    assert result["decision"] == "reject"
    if response["decision"] == "approve":
        assert "moderation_low_confidence" in result["reasons"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["invalid_json", "timeout", "no_provider"])
async def test_moderation_failures_close_the_candidate(failure):
    settings = Settings(zhipu_api_key="test-free-key" if failure != "no_provider" else "")
    gateway = ContentModerationGateway(settings, store=ModelCenterStore())

    async def fake_post(*_args):
        if failure == "timeout":
            raise httpx.TimeoutException("test timeout")
        return {"choices": [{"message": {"content": "not-json"}}]}

    gateway._post = fake_post
    result = await gateway.moderate(make_candidate(failure))

    assert result["decision"] == "reject"
    assert result["confidence"] == 0
    assert result["reasons"] == ["moderation_unavailable"]


@pytest.mark.asyncio
async def test_moderation_pipeline_enforces_run_cap_and_skips_repeat_calls(pipeline):
    with pipeline.database.session() as session:
        for index in range(7):
            session.add(ContentCandidate(
                source_id="crossref-api",
                external_id=f"review-{index}",
                canonical_url=f"https://example.org/review-{index}",
                title=f"Boundary research article {index}",
                summary="A bounded abstract with enough evidence for semantic review.",
                authors=["Research Team"],
                source_published_at=datetime.now(timezone.utc),
                topic="科技",
                content_kind="paper",
                peer_review_status="peer_reviewed",
                source_tier="A",
                license="metadata indexing allowed",
                raw_hash=f"review-hash-{index}",
                title_fingerprint=f"review-title-{index}",
                quality_score=80,
                status="review",
                metadata_json={
                    "pipelineRunId": "run-cap",
                    "moderation": {"ruleReviewReasons": ["health_claim_requires_review"]},
                },
            ))

    calls = []

    class FakeModeration:
        async def moderate(self, candidate):
            calls.append(candidate.id)
            return {
                "decision": "approve",
                "confidence": 0.91,
                "reasons": [],
                "provider": "fake",
                "model": "fake-model",
                "inputHash": f"hash-{candidate.external_id}",
            }

    pipeline.moderation = FakeModeration()
    accepted, stats = await pipeline._moderate_review_candidates("run-cap", limit=6)

    assert len(accepted) == 6
    assert len(calls) == 6
    assert stats["accepted"] == 6
    assert stats["rejected"] == 1
    assert stats["aiAccepted"] == 6
    assert stats["aiRejected"] == 0
    assert stats["aiSkipped"] == 1
    assert stats["reasons"] == {"moderation_run_limit": 1}

    accepted_again, stats_again = await pipeline._moderate_review_candidates("run-cap", limit=6)
    assert accepted_again == []
    assert stats_again["accepted"] == 0
    assert len(calls) == 6
    with pipeline.database.session() as session:
        stored = list(session.scalars(select(ContentCandidate)))
        assert sum(item.status == "accepted" for item in stored) == 6
        limited = next(item for item in stored if item.external_id == "review-6")
        assert limited.status == "rejected"
        assert limited.rejection_reason == "moderation_run_limit"
        assert limited.metadata_json["moderation"]["inputHash"]


@pytest.mark.asyncio
async def test_moderation_pure_discovery_does_not_spend_ai(pipeline):
    class FakeClient:
        def record_count(self, *_args, **_kwargs):
            return None

    class FakeAdapter:
        policy = SimpleNamespace(id="crossref-api", topics=TOPICS, fullTextAllowed=False)
        client = FakeClient()

        async def fetch(self, _limit, _offset=0):
            candidate = make_candidate("boundary-discovery")
            candidate.summary = (
                "This treatment guarantees a cure according to a claim that requires careful "
                "semantic review before any learning article could be published."
            )
            return [candidate]

    class ForbiddenModeration:
        async def moderate(self, _candidate):
            raise AssertionError("pure discovery must not call AI")

    pipeline.adapters = [FakeAdapter()]
    pipeline.moderation = ForbiddenModeration()
    result = await pipeline.run(limit=1, generate=False, publish=False)

    assert result["acceptedCount"] == 0
    assert result["rejectedCount"] == 0
    assert result["reviewCount"] == 1
    assert result["moderationStats"]["aiSkipped"] == 1
    assert pipeline.list_candidates(status="review")[0]["status"] == "review"


def test_moderation_body_only_danger_is_blocked(pipeline):
    candidate = make_candidate("body-only-danger")
    candidate.metadata = {
        "paragraphs": [
            "A calm introduction explains a public research project and its background.",
            "These step by step instructions explain how to make an explosive device and cause serious injury.",
            "The conclusion returns to ordinary educational material without changing the dangerous body.",
        ]
    }

    accepted_ids, stats, _coverage = pipeline._filter_and_store([candidate], run_id="body-only-danger")

    assert accepted_ids == []
    assert stats["rejected"] == 1
    stored = pipeline.list_candidates(limit=1)[0]
    assert stored["status"] == "rejected"
    assert "dangerous_instruction" in stored["rejectionReason"]
