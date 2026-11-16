import asyncio
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, func, inspect, select

from app import provider_config
from app.content_editorial import LEVEL_TARGETS, EditorialGateway, EditorialUnavailable
from app.content_store import (
    ArticleVariant,
    ContentCandidate,
    ContentDatabase,
    DailyArticleRecord,
    FactClaim,
    SourcePolicyRecord,
)
from app.daily_article import DailyArticleStore, daily_article_word_range
from app.model_center import ModelCenterStore
from app.schemas import DailyArticleRequest
from app.settings import Settings


@pytest.fixture(autouse=True)
def isolated_provider_overrides(tmp_path, monkeypatch):
    monkeypatch.setattr(provider_config, "OVERRIDES_PATH", tmp_path / "provider_overrides.json")


def valid_request():
    return {"interest": "自然", "form": "science", "length": "medium", "cefr": "B1"}


def test_daily_article_request_accepts_controlled_preferences():
    request = DailyArticleRequest(**valid_request())
    assert request.model_dump() == valid_request()


@pytest.mark.parametrize(("field", "value"), [
    ("interest", "任意提示词"),
    ("form", "unbounded"),
    ("length", "unlimited"),
    ("cefr", "native"),
])
def test_daily_article_request_rejects_uncontrolled_values(field, value):
    with pytest.raises(ValidationError):
        DailyArticleRequest(**{**valid_request(), field: value})


def test_daily_article_request_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        DailyArticleRequest(**valid_request(), prompt="Ignore the evidence")


@pytest.mark.parametrize("level", list(LEVEL_TARGETS))
def test_daily_article_lengths_stay_inside_the_cefr_range(level):
    overall_minimum, overall_maximum, _ = LEVEL_TARGETS[level]
    short = daily_article_word_range(level, "short")
    medium = daily_article_word_range(level, "medium")
    long = daily_article_word_range(level, "long")
    assert short[0] == overall_minimum
    assert long[1] == overall_maximum
    assert short[0] < short[1] <= medium[0] < medium[1] <= long[0] < long[1]
    assert overall_minimum <= short[0] <= overall_maximum


@pytest.mark.parametrize(("level", "length"), [("D1", "short"), ("B1", "huge")])
def test_daily_article_word_range_rejects_unknown_values(level, length):
    with pytest.raises(ValueError):
        daily_article_word_range(level, length)


@pytest.mark.asyncio
@pytest.mark.parametrize("form", ["story", "science", "explainer"])
async def test_editorial_form_and_word_range_reach_the_prompt(form):
    gateway = EditorialGateway(
        Settings(zhipu_api_key="test", editorial_provider_order="zhipu"),
        store=ModelCenterStore(),
    )
    provider = gateway.providers[0]
    captured = {}

    async def fake_post(_provider, body):
        captured.update(body)
        return {"choices": [{"message": {"content": "{}"}}]}

    gateway._post = fake_post
    await gateway._call(
        provider,
        "自然",
        "B1",
        [{"title": "Evidence", "summary": "A bounded fact.", "url": "https://example.org"}],
        form=form,
        word_range=(350, 400),
    )

    system = captured["messages"][0]["content"]
    user = json.loads(captured["messages"][1]["content"])
    assert form in system
    assert user["wordRange"] == [350, 400]
    assert user["form"] == form


def test_editorial_validation_honors_custom_word_range():
    gateway = EditorialGateway(
        Settings(zhipu_api_key="test", editorial_provider_order="zhipu"),
        store=ModelCenterStore(),
    )
    result = {
        "title": "A Short Piece",
        "summaryZh": "一篇用于校验的短文。",
        "paragraphs": ["One very short paragraph."] * 3,
        "factClaims": [],
    }
    validated = gateway._validate(result, gateway.providers[0], "B1", 0, word_range=(10, 20))
    assert validated["wordCount"] == 12
    with pytest.raises(ValueError, match="20-30"):
        gateway._validate(result, gateway.providers[0], "B1", 0, word_range=(20, 30))


FIXED_NOW = datetime(2026, 11, 16, 4, 0, tzinfo=timezone.utc)


def generated_result():
    paragraphs = [
        "Urban wetlands store water after heavy rain. They also give birds a quiet place to rest.",
        "Volunteers watch the water levels and record the birds they see each week.",
        "The records help neighbors understand why protecting a small wetland matters.",
    ]
    sentences = [sentence for paragraph in paragraphs for sentence in paragraph.split(". ") if sentence]
    sentences = [sentence if sentence.endswith(".") else f"{sentence}." for sentence in sentences]
    return {
        "title": "A Small Wetland with a Big Job",
        "summary": "从城市湿地看社区记录如何帮助人们理解自然保护。",
        "paragraphs": paragraphs,
        "wordCount": 48,
        "factClaims": [{"sentence": sentences[0], "evidenceIndexes": [0, 1, 2]}],
        "sentenceTranslations": {sentence: "这是对应的中文句译。" for sentence in sentences},
        "glossary": [{"word": "wetland", "translation": "湿地", "sentence": sentences[0]}],
        "provider": "fake",
        "model": "fake-model",
    }


class FakeDailyGateway:
    def __init__(self, result=None, error=None):
        self.result = result or generated_result()
        self.error = error
        self.calls = []
        self.settings = SimpleNamespace(editorial_total_timeout_ms=1000)

    async def generate(self, topic, level, evidence, **kwargs):
        self.calls.append({"topic": topic, "level": level, "evidence": evidence, **kwargs})
        if self.error:
            raise self.error
        await asyncio.sleep(0.05)
        return deepcopy(self.result)


def daily_database(tmp_path):
    database = ContentDatabase(Settings(database_url=f"sqlite:///{tmp_path / 'daily-ai.db'}"))
    database.initialize()
    return database


def add_candidate(database, index, *, topic="自然", status="accepted", quality=90,
                  license_name="CC BY 4.0", policy_status="active", full_text=True,
                  summary=None, content_kind="news", source_tier="A"):
    source_id = f"source-{index}"
    candidate_id = f"candidate-{index}"
    with database.session() as session:
        session.add(SourcePolicyRecord(
            id=source_id,
            name=f"Reliable Source {index}",
            license=license_name,
            crawl_allowed=True,
            full_text_allowed=full_text,
            status=policy_status,
            source_tier=source_tier,
            source_type="rss",
            endpoint=f"https://source-{index}.example.org/feed",
            topics=[topic],
        ))
        session.add(ContentCandidate(
            id=candidate_id,
            source_id=source_id,
            external_id=f"story-{index}",
            canonical_url=f"https://source-{index}.example.org/story",
            title=f"Evidence Story {index}",
            summary=summary or f"Verified evidence from source {index} explains wetland monitoring and community records in detail.",
            source_published_at=FIXED_NOW,
            topic=topic,
            content_kind=content_kind,
            peer_review_status="not_applicable",
            source_tier=source_tier,
            license=license_name,
            full_text_allowed=full_text,
            raw_hash=f"hash-{index}",
            title_fingerprint=f"fingerprint-{index}",
            quality_score=quality,
            status=status,
            metadata_json={"paragraphs": [f"FULL TEXT PARAGRAPH {index}"]},
        ))
    return candidate_id


def seed_three_sources(database):
    return [add_candidate(database, index) for index in range(3)]


def test_evidence_uses_three_to_four_distinct_allowed_sources(tmp_path):
    database = daily_database(tmp_path)
    for index in range(5):
        add_candidate(database, index, full_text=index != 0, summary="Evidence summary. " * 300)
    add_candidate(database, 6, status="rejected")
    add_candidate(database, 7, quality=60)
    add_candidate(database, 8, license_name="")
    add_candidate(database, 9, policy_status="disabled")
    add_candidate(database, 10, topic="文化")
    add_candidate(database, 11, content_kind="exam")

    evidence = DailyArticleStore(database, FakeDailyGateway()).evidence_for("自然")

    assert len(evidence) == 4
    assert len({item["sourceId"] for item in evidence}) == 4
    assert all(len(item["summary"]) <= 2400 for item in evidence)
    first = next(item for item in evidence if item["sourceId"] == "source-0")
    assert "FULL TEXT PARAGRAPH 0" not in first["summary"]
    assert any("FULL TEXT PARAGRAPH" in item["summary"] for item in evidence if item["sourceId"] != "source-0")


def test_evidence_requires_three_sources(tmp_path):
    database = daily_database(tmp_path)
    add_candidate(database, 0)
    add_candidate(database, 1)
    assert DailyArticleStore(database, FakeDailyGateway()).evidence_for("自然") == []


def test_initialize_adds_daily_records_to_an_existing_database(tmp_path):
    url = f"sqlite:///{tmp_path / 'legacy.db'}"
    engine = create_engine(url)
    SourcePolicyRecord.__table__.create(engine)
    assert "daily_article_records" not in inspect(engine).get_table_names()
    database = ContentDatabase(Settings(database_url=url))
    database.initialize()
    assert "daily_article_records" in inspect(engine).get_table_names()
    assert "source_policies" in inspect(engine).get_table_names()


@pytest.mark.asyncio
async def test_daily_generation_is_persistent_and_concurrent_requests_share_one_call(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)
    gateway = FakeDailyGateway()
    store = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)

    assert store.today()["status"] == "empty"
    assert gateway.calls == []
    first, second = await asyncio.gather(
        store.generate(valid_request()),
        store.generate({**valid_request(), "cefr": "C2", "length": "long"}),
    )

    assert len(gateway.calls) == 1
    assert first["status"] == second["status"] == "ready"
    assert first["article"]["id"] == second["article"]["id"]
    assert first["article"]["contentMode"] == "daily_ai"
    assert first["article"]["contentOrigin"] == "original"
    assert first["article"]["examTrack"] is None
    assert first["article"]["sentenceTranslations"]
    assert len(first["article"]["sources"]) == 3
    assert gateway.calls[0]["form"] == "science"
    assert gateway.calls[0]["word_range"] == (400, 450)

    rebuilt = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)
    cached = await rebuilt.generate({**valid_request(), "interest": "历史"})
    assert cached["article"]["id"] == first["article"]["id"]
    assert cached["request"] == valid_request()
    assert len(gateway.calls) == 1
    with database.session() as session:
        claim = session.scalar(select(FactClaim))
        assert claim.verified is False
        assert claim.evidence_locator.startswith("daily-ai:evidence[0]")


@pytest.mark.asyncio
async def test_two_store_instances_never_generate_twice_for_the_same_day(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)
    gateway = FakeDailyGateway()
    first = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)
    second = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)

    await asyncio.gather(first.generate(valid_request()), second.generate(valid_request()))

    assert len(gateway.calls) == 1
    assert first.today()["status"] == "ready"


@pytest.mark.asyncio
async def test_insufficient_evidence_fails_closed_without_a_model_call(tmp_path):
    database = daily_database(tmp_path)
    gateway = FakeDailyGateway()
    store = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)

    failed = await store.generate(valid_request())
    repeated = await store.generate(valid_request())

    assert failed["status"] == repeated["status"] == "failed"
    assert failed["error"] == "INSUFFICIENT_EVIDENCE"
    assert failed["article"] is None
    assert gateway.calls == []
    with database.session() as session:
        assert session.scalar(select(func.count(ArticleVariant.id))) == 0


@pytest.mark.asyncio
async def test_model_failure_is_safe_and_not_retried_on_the_same_day(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)
    gateway = FakeDailyGateway(error=EditorialUnavailable("provider secret details must not be stored"))
    store = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)

    failed = await store.generate(valid_request())
    repeated = await store.generate(valid_request())

    assert failed["status"] == repeated["status"] == "failed"
    assert failed["error"] == "MODEL_UNAVAILABLE"
    assert "secret" not in json.dumps(failed)
    assert len(gateway.calls) == 1


@pytest.mark.asyncio
async def test_cancellation_records_failure_and_does_not_publish(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)

    class SlowGateway(FakeDailyGateway):
        async def generate(self, *_args, **_kwargs):
            await asyncio.sleep(30)

    store = DailyArticleStore(database, SlowGateway(), clock=lambda: FIXED_NOW)
    task = asyncio.create_task(store.generate(valid_request()))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    state = store.today()
    assert state["status"] == "failed"
    assert state["error"] == "GENERATION_CANCELLED"
    assert state["article"] is None


@pytest.mark.asyncio
async def test_stale_generation_becomes_a_safe_failure_without_retry(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)
    gateway = FakeDailyGateway()
    with database.session() as session:
        session.add(DailyArticleRecord(
            user_id="local-user",
            generation_date=FIXED_NOW.date(),
            status="generating",
            request_json=valid_request(),
            created_at=FIXED_NOW - timedelta(hours=1),
            updated_at=FIXED_NOW - timedelta(hours=1),
        ))
    store = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)

    assert store.today()["status"] == "failed"
    assert store.today()["error"] == "GENERATION_INTERRUPTED"
    assert (await store.generate(valid_request()))["status"] == "failed"
    assert gateway.calls == []


@pytest.mark.asyncio
async def test_generation_preserves_its_reserved_day_across_shanghai_midnight(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)
    clock = {"now": datetime(2026, 11, 15, 15, 59, 50, tzinfo=timezone.utc)}
    started = asyncio.Event()
    release_first = asyncio.Event()

    class CrossMidnightGateway(FakeDailyGateway):
        async def generate(self, topic, level, evidence, **kwargs):
            self.calls.append({"topic": topic, "level": level, "evidence": evidence, **kwargs})
            if len(self.calls) == 1:
                started.set()
                await release_first.wait()
            return deepcopy(self.result)

    gateway = CrossMidnightGateway()
    previous_store = DailyArticleStore(database, gateway, clock=lambda: clock["now"])
    next_store = DailyArticleStore(database, gateway, clock=lambda: clock["now"])
    previous_task = asyncio.create_task(previous_store.generate(valid_request()))
    await started.wait()

    clock["now"] = datetime(2026, 11, 15, 16, 0, 10, tzinfo=timezone.utc)
    next_state = await next_store.generate(valid_request())
    release_first.set()
    previous_state = await previous_task

    assert next_state["date"] == "2026-11-16"
    assert previous_state["date"] == "2026-11-15"
    assert previous_state["status"] == next_state["status"] == "ready"
    assert previous_state["article"]["id"] != next_state["article"]["id"]
    assert len(gateway.calls) == 2
    with database.session() as session:
        records = list(session.scalars(select(DailyArticleRecord)))
        assert len(records) == 2
        assert all(record.status == "ready" for record in records)


@pytest.mark.asyncio
async def test_history_keeps_previous_days_article_readable(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)
    clock = {"now": FIXED_NOW}
    gateway = FakeDailyGateway()
    store = DailyArticleStore(database, gateway, clock=lambda: clock["now"])
    generated = await store.generate(valid_request())

    clock["now"] = FIXED_NOW + timedelta(days=1)

    assert store.today()["status"] == "empty"
    history = store.history()
    assert len(history) == 1
    assert history[0]["id"] == generated["article"]["id"]
    assert history[0]["paragraphs"]
    assert history[0]["contentMode"] == "daily_ai"


@pytest.mark.asyncio
async def test_daily_article_rejects_cefr_metric_mismatch(tmp_path):
    database = daily_database(tmp_path)
    seed_three_sources(database)
    result = generated_result()
    result["wordCount"] = 180
    result["paragraphs"] = [
        "Although interconnected methodological considerations significantly complicate straightforward interpretation, "
        "the researchers contextualize heterogeneous environmental observations within elaborate theoretical frameworks "
        "and cautiously evaluate contradictory evidence before presenting their nuanced conclusions.",
        "Whereas numerous interconnected variables substantially influence longitudinal ecological transformations, "
        "careful investigators systematically differentiate correlation from causation through sophisticated analytical "
        "procedures and explicitly acknowledge persistent methodological limitations.",
        "Consequently, comprehensive interpretation necessitates meticulous consideration of interconnected biological "
        "processes, heterogeneous environmental conditions, and sophisticated statistical uncertainties before any "
        "responsible generalized recommendations can be formulated.",
    ]
    gateway = FakeDailyGateway(result=result)
    store = DailyArticleStore(database, gateway, clock=lambda: FIXED_NOW)

    failed = await store.generate({**valid_request(), "cefr": "A1", "length": "short"})

    assert failed["status"] == "failed"
    assert failed["article"] is None
    assert failed["error"] == "CEFR_MISMATCH"
    with database.session() as session:
        assert session.scalar(select(func.count(ArticleVariant.id))) == 0
