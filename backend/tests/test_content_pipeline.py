import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

from app.content_pipeline import (
    ContentPipeline,
    difficulty_metrics,
    excerpt_coherence,
    split_reading_sentences,
    validate_candidate,
)
from app.content_editorial import EditorialGateway, EditorialProvider
from app import content_sources as content_sources_module
from app.content_sources import (
    CdcEidAdapter,
    RawCandidate,
    RespectfulHttpClient,
    RssAdapter,
    SOURCE_POLICIES,
    TOPICS,
)
from app.content_store import (
    ArticleVariant,
    ContentCandidate,
    ContentDatabase,
    DailyEdition,
    StoryCluster,
)
from app.text_excerpt import paragraphs_from_article_html, paragraphs_from_html
from app.settings import Settings
from app.translation import TranslationGateway


def make_candidate(
    index: int,
    *,
    topic: str = "科技",
    source_id: str = "crossref-api",
    days_old: int = 1,
    content_kind: str = "paper",
    external_id: str | None = None,
    full_text_allowed: bool = False,
    now: datetime | None = None,
) -> RawCandidate:
    clock = now or datetime.now(timezone.utc)
    return RawCandidate(
        source_id=source_id,
        external_id=external_id or f"candidate-{index}",
        title=f"Researchers report a useful new finding number {index}",
        url=f"https://example.org/research/{index}",
        published_at=clock - timedelta(days=days_old),
        summary=(
            "The research team reports a recent result and explains the evidence, "
            "methods, limitations, and relevance for readers who want reliable information."
        ),
        authors=["Research Team"],
        topic=topic,
        content_kind=content_kind,
        peer_review_status="peer_reviewed",
        license="metadata indexing allowed",
        full_text_allowed=full_text_allowed,
        source_tier="A",
    )


@pytest.fixture
def pipeline(tmp_path):
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'content-test.db'}",
        content_discovery_min=10,
        content_discovery_max=30,
        editorial_provider_order="",
        paid_provider_enabled=False,
    )
    database = ContentDatabase(settings)
    instance = ContentPipeline(settings, database)
    instance.initialize()
    return instance


def test_apod_index_pages_are_rejected():
    candidate = make_candidate(8, source_id="nasa-rss", content_kind="news", full_text_allowed=True)
    candidate.title = "APOD: 2026 September 20 – Analemma over the Callanish Stones"
    candidate.url = "https://apod.nasa.gov/apod/ap260920.html"
    assert "low_quality_index_or_chrome" in validate_candidate(candidate, datetime.now(timezone.utc))


def test_reading_sentences_keep_titles_initials_and_decimals_together():
    sentences = split_reading_sentences(
        "Dr. Reed arrived in the U.S. yesterday. It costs 3.14 dollars. She left."
    )
    assert sentences == [
        "Dr. Reed arrived in the U.S. yesterday.",
        "It costs 3.14 dollars.",
        "She left.",
    ]
    metrics = difficulty_metrics([
        "Dr. Reed arrived in the U.S. yesterday. She started reading about shade."
    ])
    assert metrics["sentenceCount"] == 2


def test_freshness_windows_and_complete_excerpt_rules():
    now = datetime.now(timezone.utc)
    assert "older_than_90_days" in validate_candidate(
        make_candidate(1, days_old=91, content_kind="news", now=now),
        now,
    )
    assert "older_than_90_days" in validate_candidate(
        make_candidate(2, days_old=92, content_kind="paper", now=now),
        now,
    )
    assert "older_than_365_days" in validate_candidate(
        make_candidate(3, days_old=367, content_kind="evergreen", now=now),
        now,
    )
    novel = make_candidate(4, days_old=4000, content_kind="literature", topic="文化", now=now)
    novel.summary = (
        "The research team reports a recent result and explains the evidence, "
        "methods, limitations, and relevance for readers who want reliable information."
    )
    assert validate_candidate(novel, now) == []

    coherent, reasons = excerpt_coherence([
        "However, the missing paragraph explains the subject before this point.",
        "The body contains evidence and context for the central idea. " * 8,
        "The conclusion closes the discussion with a complete final sentence. " * 8,
    ])
    assert coherent is False
    assert "opening_depends_on_missing_context" in reasons


def test_candidate_requires_english_title_and_evidence_text():
    now = datetime.now(timezone.utc)
    non_english_title = make_candidate(20)
    non_english_title.title = "水利电力工匠精神赋能立德树人实践路径"
    assert "not_english_title" in validate_candidate(non_english_title, now)

    missing_evidence = make_candidate(21)
    missing_evidence.summary = "A short metadata note."
    reasons = validate_candidate(missing_evidence, now)
    assert "insufficient_evidence_text" in reasons


def test_chinese_wikipedia_source_skips_english_filters():
    now = datetime.now(timezone.utc)
    candidate = make_candidate(
        31,
        source_id="zhwiki-featured",
        content_kind="evergreen",
        full_text_allowed=True,
    )
    candidate.title = "脉冲星是高速旋转的中子星"
    candidate.summary = (
        "脉冲星是一类高速自转的中子星。它们会周期性地发出电磁辐射，"
        "天文学家据此研究恒星演化、极端磁层以及星际介质中的物质分布。"
        "这篇条目还说明了发现经过，以及脉冲周期为何能当作宇宙中的天然时钟。"
    )
    candidate.metadata = {"sourceLanguage": "zh"}
    candidate.license = "CC BY-SA 4.0"
    assert validate_candidate(candidate, now) == []


def test_translated_english_from_chinese_keeps_cefr_bounds():
    body = (
        "A pulsar is a neutron star that spins very quickly and sends out regular beams of energy. "
        "Astronomers use those repeating signals to study extreme physics and the space between stars. "
        "The pattern is steady enough to act like a natural clock in the sky. "
    ) * 4
    result = EditorialGateway._validate_english_from_chinese({
        "title": "What a pulsar is",
        "introZh": "这篇课文用浅白英语介绍脉冲星如何旋转并发光。",
        "paragraphs": [
            body,
            "Researchers compare the pulse times and look for changes that reveal the star's motion. " * 8,
            "This article keeps the original claims and does not add extra numbers or names. " * 8,
        ],
    })
    assert result["title"] == "What a pulsar is"
    assert len(result["paragraphs"]) == 3
    assert "脉冲星" in result["introZh"]


@pytest.mark.asyncio
async def test_discovery_expands_only_until_topic_floor_is_reached(pipeline):
    class FakeClient:
        def record_count(self, *_args, **_kwargs):
            return None

    class FakeAdapter:
        policy = SimpleNamespace(id="crossref-api", topics=TOPICS)
        client = FakeClient()

        def __init__(self):
            self.calls = []

        async def fetch(self, limit, offset=0):
            self.calls.append((limit, offset))
            return [
                make_candidate(
                    offset + index,
                    topic=TOPICS[(offset + index) % len(TOPICS)],
                )
                for index in range(limit)
            ]

    adapter = FakeAdapter()
    pipeline.adapters = [adapter]
    candidates, stats = await pipeline._discover(10)

    assert len(candidates) == 30
    assert adapter.calls == [(10, 0), (20, 10)]
    assert stats["crossref-api"]["requests"] == 2
    assert {topic: sum(item.topic == topic for item in candidates) for topic in TOPICS} == {
        topic: 5 for topic in TOPICS
    }


def test_filter_deduplicates_and_never_escalates_full_text_permission(pipeline):
    original = make_candidate(1, full_text_allowed=True)
    duplicate = make_candidate(
        2,
        external_id="different-external-id",
        full_text_allowed=True,
    )
    duplicate.title = original.title
    duplicate.url = "https://example.org/a-republished-copy"

    accepted_ids, stats, _coverage = pipeline._filter_and_store(
        [original, duplicate],
        run_id="unit-test",
    )
    stored = pipeline.list_candidates(limit=10)

    assert len(accepted_ids) == 1
    assert stats["duplicates"] == 1
    assert len(stored) == 1
    assert stored[0]["fullTextAllowed"] is False


def test_content_levels_ignore_legacy_server_profiles(pipeline):
    from sqlalchemy import text

    with pipeline.database.engine.begin() as connection:
        connection.execute(text("create table profiles (cefr text, is_active boolean)"))
        connection.execute(text("insert into profiles values ('C1', true)"))
    pipeline.settings.content_active_cefr_levels = "A2,B1,C1"

    assert pipeline.active_cefr_levels() == ["A2", "B1", "C1"]


def test_zero_budget_excludes_routes_that_can_auto_charge():
    gateway = TranslationGateway(
        Settings(
            paid_provider_enabled=False,
            zhipu_api_key="free-zhipu",
            siliconflow_api_key="silicon-key",
            siliconflow_model="Qwen/Qwen2.5-72B-Instruct",
            tencent_secret_id="configured-id",
            tencent_secret_key="configured-key",
            dashscope_api_key="configured-dashscope",
            deepseek_api_key="configured-deepseek",
            translation_provider_order="zhipu,siliconflow,tencent,dashscope,deepseek",
        )
    )

    assert [provider.name for provider in gateway.providers] == ["zhipu"]
    status = {item["provider"]: item for item in gateway.provider_status()}
    assert status["siliconflow"]["status"] == "blocked_by_zero_budget"
    assert status["tencent"]["status"] == "blocked_by_zero_budget"
    assert status["dashscope"]["status"] == "blocked_by_zero_budget"
    assert status["deepseek"]["status"] == "blocked_by_zero_budget"
    assert status["deepseek"]["billingClass"] == "cheap_api"


@pytest.mark.asyncio
@pytest.mark.parametrize("paid_provider_enabled", [False, True])
async def test_zero_budget_never_invokes_deepseek(paid_provider_enabled):
    gateway = TranslationGateway(
        Settings(
            paid_provider_enabled=paid_provider_enabled,
            daily_paid_budget_cny=0,
            deepseek_api_key="configured-deepseek",
            translation_provider_order="deepseek",
        )
    )
    calls = []

    async def forbidden_call(provider, *_args):
        calls.append(provider.name)
        return {"translation": "禁止调用"}

    gateway._call_provider = forbidden_call
    with pytest.raises(RuntimeError):
        await gateway.translate(
            "word",
            {"word": "unlistedword", "sentence": "This route must stay offline."},
        )
    assert calls == []


@pytest.mark.asyncio
async def test_zero_budget_never_invokes_custom_cheap_api(monkeypatch):
    monkeypatch.setattr("app.translation.load_overrides", lambda: {
        "order": ["custom-paid"],
        "providers": {
            "custom-paid": {
                "kind": "openai",
                "baseUrl": "https://provider.invalid/v1",
                "model": "paid-model",
                "apiKey": "configured-custom-key",
                "cheapApi": True,
            },
        },
    })
    gateway = TranslationGateway(
        Settings(paid_provider_enabled=True, daily_paid_budget_cny=0)
    )
    calls = []

    async def forbidden_call(provider, *_args):
        calls.append(provider.name)
        return {"translation": "禁止调用"}

    gateway._call_provider = forbidden_call
    with pytest.raises(RuntimeError):
        await gateway.translate(
            "word",
            {"word": "unlistedword", "sentence": "This custom route must stay offline."},
        )
    assert calls == []


@pytest.mark.asyncio
async def test_cheap_paid_route_still_consumes_daily_budget():
    gateway = TranslationGateway(
        Settings(
            paid_provider_enabled=True,
            daily_paid_budget_cny=1,
            paid_fallback_mode="automatic",
            deepseek_api_key="configured-deepseek",
            translation_provider_order="deepseek",
        )
    )
    calls = []

    async def fake_call(provider, *_args):
        calls.append(provider.name)
        return {"translation": "河岸", "lemma": "bank"}

    gateway._call_provider = fake_call
    await gateway.translate(
        "word",
        {"word": "bank", "sentence": "We sat on the river bank.", "qualityMode": "precise"},
    )
    gateway.settings.daily_paid_budget_cny = gateway.overview()["costGuard"]["reservedTodayCny"]
    with pytest.raises(RuntimeError):
        await gateway.translate(
            "word",
            {"word": "bank", "sentence": "The river bank is quiet today.", "qualityMode": "precise"},
        )
    assert calls == ["deepseek"]


@pytest.mark.asyncio
async def test_automatic_mode_allows_budgeted_deepseek_for_default_reader_requests():
    gateway = TranslationGateway(
        Settings(
            paid_provider_enabled=True,
            daily_paid_budget_cny=1,
            paid_fallback_mode="automatic",
            deepseek_api_key="configured-deepseek",
            translation_provider_order="deepseek",
        )
    )

    async def fake_call(*_args):
        return {"translation": "河岸", "lemma": "bank"}

    gateway._call_provider = fake_call
    result = await gateway.translate(
        "word",
        {"word": "bank", "sentence": "We sat on the river bank.", "qualityMode": "free"},
    )
    assert result["provider"] == "deepseek"


@pytest.mark.asyncio
async def test_zero_budget_editorial_never_invokes_deepseek():
    gateway = EditorialGateway(
        Settings(
            paid_provider_enabled=True,
            daily_paid_budget_cny=0,
            deepseek_api_key="configured-deepseek",
            editorial_provider_order="deepseek",
        )
    )
    calls = []

    async def forbidden_call(provider, *_args):
        calls.append(provider.name)
        return {}

    gateway._call = forbidden_call
    with pytest.raises(RuntimeError):
        await gateway.generate("科技", "B1", [])
    assert calls == []
    assert gateway.providers == []


@pytest.mark.asyncio
async def test_editorial_paid_route_stops_when_daily_budget_is_exhausted(monkeypatch):
    gateway = EditorialGateway(
        Settings(
            paid_provider_enabled=True,
            daily_paid_budget_cny=1,
            paid_request_max_cny=1,
            deepseek_api_key="configured-deepseek",
            editorial_provider_order="deepseek",
        )
    )
    calls = []

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, url, **_kwargs):
            calls.append(url)
            return httpx.Response(
                200,
                request=httpx.Request("POST", url),
                json={"choices": [{"message": {"content": '{"introZh":"这篇英文文章介绍城市阅读空间如何帮助读者理解社区。"}'}}]},
            )

    monkeypatch.setattr("app.content_editorial.httpx.AsyncClient", FakeClient)
    first = await gateway.intro_zh(
        title="Reading in the City",
        source="Example",
        topic="文化",
        paragraphs=["Libraries create space for reading and conversation."],
    )
    assert "阅读空间" in first
    gateway.settings.daily_paid_budget_cny = sum(gateway._paid_reserved_cny.values())
    second = await gateway.intro_zh(
        title="Another City",
        source="Example",
        topic="文化",
        paragraphs=["Parks create space for reading and conversation."],
    )
    assert second.startswith("一篇来自Example")
    assert calls == ["/chat/completions"]


@pytest.mark.asyncio
async def test_source_client_reuses_etag_and_honors_304(pipeline, monkeypatch):
    responses = [
        httpx.Response(
            200,
            headers={"ETag": '"content-v1"', "Last-Modified": "Sat, 25 Jul 2026 10:00:00 GMT"},
            request=httpx.Request("GET", "https://www.nasa.gov/news-release/feed/"),
            json={"message": {"items": []}},
        ),
        httpx.Response(
            304,
            request=httpx.Request("GET", "https://www.nasa.gov/news-release/feed/"),
        ),
    ]
    captured_headers = []

    class FakeAsyncClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, url, *, headers, params=None):
            captured_headers.append(headers)
            return responses.pop(0)

    monkeypatch.setattr(content_sources_module.httpx, "AsyncClient", FakeAsyncClient)
    source = next(item for item in SOURCE_POLICIES if item.id == "nasa-rss")
    source_client = RespectfulHttpClient(pipeline.settings, pipeline.database)

    assert await source_client.get(source) is not None
    assert await source_client.get(source) is None
    assert captured_headers[1]["If-None-Match"] == '"content-v1"'
    assert captured_headers[1]["If-Modified-Since"] == "Sat, 25 Jul 2026 10:00:00 GMT"


@pytest.mark.asyncio
async def test_source_client_retries_429_without_bypassing_limit(pipeline, monkeypatch):
    responses = [
        httpx.Response(
            429,
            headers={"Retry-After": "0"},
            request=httpx.Request("GET", "https://api.crossref.org/works"),
        ),
        httpx.Response(
            200,
            request=httpx.Request("GET", "https://api.crossref.org/works"),
            json={"message": {"items": []}},
        ),
    ]
    calls = 0

    class FakeAsyncClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            return responses.pop(0)

    async def no_wait(*_args, **_kwargs):
        return None

    monkeypatch.setattr(content_sources_module.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(content_sources_module.asyncio, "sleep", no_wait)
    source = next(item for item in SOURCE_POLICIES if item.id == "crossref-api")
    source_client = RespectfulHttpClient(pipeline.settings, pipeline.database)

    response = await source_client.get(source)
    assert response.status_code == 200
    assert calls == 2


@pytest.mark.asyncio
async def test_cdc_eid_feed_keeps_only_bounded_official_abstract():
    feed = b"""<?xml version="1.0"?>
    <rss><channel><item>
      <title>A Carefully Reviewed Public Health Finding</title>
      <description>A. Reader and B. Researcher</description>
      <link>https://wwwnc.cdc.gov/eid/article/32/8/example_article</link>
      <pubDate>Sat, 25 Jul 2026 04:00:00 GMT</pubDate>
    </item></channel></rss>"""
    article = """
      <html><head><meta name="citation_doi" content="10.3201/eid3208.example"></head>
      <body>
        <div id="abstract" class="card"><div class="card-body">
          <h3>Abstract</h3>
          <p>This peer-reviewed investigation explains a public health question, the study
          design, the evidence observed by the researchers, and the limits of interpretation.
          The abstract provides enough connected context for a reliable learning digest while
          the remaining copyrighted page is not copied into the candidate database.</p>
        </div></div>
        <div id="mainbody"><p>This full article body must never be stored.</p></div>
      </body></html>
    """

    class FakeClient:
        async def robots_allowed(self, url):
            return url.startswith("https://wwwnc.cdc.gov/")

        async def get(self, policy, params=None, url=None):
            request_url = url or policy.endpoint
            return httpx.Response(
                200,
                content=article.encode() if url else feed,
                request=httpx.Request("GET", request_url),
            )

    policy = next(item for item in SOURCE_POLICIES if item.id == "cdc-eid-rss")
    candidates = await CdcEidAdapter(policy, FakeClient()).fetch(5)

    assert len(candidates) == 1
    assert candidates[0].doi == "10.3201/eid3208.example"
    assert "full article body" not in candidates[0].summary
    assert candidates[0].metadata["abstractSource"] == "official-article-page"
    assert candidates[0].full_text_allowed is False
    assert candidates[0].authors == ["A. Reader", "B. Researcher"]


def test_editorial_numbers_require_verbatim_evidence_binding():
    factual_sentence = "The study found 12 measurable changes."
    paragraphs = [
        f"{factual_sentence} " + "Readers can understand the careful research process. " * 10,
        "The article explains the evidence in clear and connected language. " * 10,
        "The conclusion returns to the main idea and explains its limits. " * 10,
    ]
    provider = EditorialProvider("zhipu", "https://example.test", "free-model", "test-key")
    base = {
        "title": "A Clear Research Finding",
        "summaryZh": "一篇可追溯的学习导读。",
        "paragraphs": paragraphs,
    }

    with pytest.raises(ValueError, match="missing evidence binding"):
        EditorialGateway._validate({**base, "factClaims": []}, provider, "A2", 1)

    valid = EditorialGateway._validate(
        {
            **base,
            "factClaims": [{"sentence": factual_sentence, "evidenceIndexes": [0]}],
        },
        provider,
        "A2",
        1,
    )
    assert valid["factClaims"][0]["evidenceIndexes"] == [0]


def test_production_editorial_requires_aligned_translations_and_contextual_glossary():
    words = (
        "curious readers explore clear ideas through gentle stories while language grows "
        "naturally with context practice patience reflection meaning memory rhythm attention dialogue"
    ).split()
    first = " ".join(words * 5).capitalize() + "."
    second = "Patient learners " + " ".join(words * 5) + "."
    third = "Thoughtful learners " + " ".join(words * 5) + "."
    paragraphs = [first, second, third]
    provider = EditorialProvider("zhipu", "https://example.test", "free-model", "test-key")
    result = {
        "title": "A Calm Way to Read",
        "summaryZh": "一篇带有完整预生成学习资料的导读。",
        "paragraphs": paragraphs,
        "factClaims": [],
        "sentenceTranslations": {
            first: "好奇的读者通过平和的故事探索清晰的观点。",
            second: "耐心的学习者在语境中练习语言。",
            third: "善于思考的学习者让词义逐渐进入长期记忆。",
        },
        "glossary": [
            {
                "word": word,
                "lemma": word,
                "partOfSpeech": "",
                "phonetic": "",
                "translation": f"{word} 的语境释义",
                "sentence": first,
            }
            for word in words[:15]
        ],
    }

    validated = EditorialGateway._validate(
        result,
        provider,
        "A2",
        1,
        require_learning_assets=True,
    )
    assert len(validated["sentenceTranslations"]) == 3
    assert len(validated["glossary"]) == 15

    missing_sentence = {
        **result,
        "sentenceTranslations": {
            first: result["sentenceTranslations"][first],
            second: result["sentenceTranslations"][second],
        },
    }
    with pytest.raises(ValueError, match="aligned sentence translations"):
        EditorialGateway._validate(
            missing_sentence,
            provider,
            "A2",
            1,
            require_learning_assets=True,
        )


def test_daily_edition_never_exceeds_twelve_active_level_variants(pipeline):
    target = date(2026, 7, 27)
    with pipeline.database.session() as session:
        for index, topic in enumerate(TOPICS[:5]):
            candidate = ContentCandidate(
                source_id="crossref-api",
                external_id=f"publish-{index}",
                canonical_url=f"https://example.org/publish/{index}",
                title=f"Complete learning story {index}",
                summary="A reliable source summary with enough evidence and context for careful reading.",
                authors=["Editorial Team"],
                source_published_at=datetime.now(timezone.utc),
                topic=topic,
                content_kind="paper",
                peer_review_status="peer_reviewed",
                source_tier="A",
                license="metadata indexing allowed",
                full_text_allowed=False,
                raw_hash=f"raw-{index}",
                title_fingerprint=f"title-{index}",
                quality_score=94,
                status="accepted",
            )
            session.add(candidate)
            session.flush()
            cluster = StoryCluster(
                topic=topic,
                canonical_title=candidate.title,
                candidate_ids=[candidate.id],
                independent_source_ids=["crossref-api"],
                evidence_score=94,
                risk_level="low",
                status="ready",
            )
            session.add(cluster)
            session.flush()
            for level in ("A2", "B1", "B2", "C1"):
                session.add(ArticleVariant(
                    story_cluster_id=cluster.id,
                    source_candidate_id=candidate.id,
                    title=f"{candidate.title} · {level}",
                    summary="完整的中文导读摘要。",
                    paragraphs=["A complete opening.", "A connected body.", "A closed conclusion."],
                    sentence_translations={
                        "A complete opening.": "完整开头。",
                        "A connected body.": "连贯主体。",
                        "A closed conclusion.": "闭合结论。",
                    },
                    glossary=[],
                    body_hash=f"body-{index}-{level}",
                    cefr=level,
                    word_count=300,
                    reading_minutes=3,
                    topic=topic,
                    peer_review_status="peer_reviewed",
                    quality_score=92,
                    difficulty_metrics={"estimatedCefr": level},
                    source_published_at=datetime.now(timezone.utc),
                    sources=[{"label": "crossref-api", "url": candidate.canonical_url}],
                    risk_flags=[],
                    review_status="approved",
                ))

    assert pipeline.publish_today(target) == 12
    with pipeline.database.session() as session:
        edition = session.get(DailyEdition, target)
        assert edition is not None
        assert edition.coverage["stories"] == 3
        assert edition.coverage["variants"] == 12
        assert edition.coverage["levels"] == {"A2": 3, "B1": 3, "B2": 3, "C1": 3}


@pytest.mark.asyncio
async def test_licensed_original_excerpt_becomes_an_article(pipeline):
    pipeline.settings.content_auto_publish = True
    body = (
        "Researchers describe a careful public experiment in city parks and libraries. "
        "They measured shade, reading time, and how neighbors talked about books together. "
    )
    paragraphs = [
        "City parks can become quiet rooms for thought when trees and benches are placed with care.",
        body * 8,
        "The same study says independent bookstores still help people meet, read, and grow together in a fast city.",
        "These rooms are public squares in miniature, and they remain worth supporting this year.",
    ]
    candidate = make_candidate(
        30,
        source_id="nasa-rss",
        content_kind="news",
        full_text_allowed=True,
        topic="科技",
    )
    candidate.title = "Why City Parks Still Help People Read Together"
    candidate.summary = " ".join(paragraphs)
    candidate.metadata = {"paragraphs": paragraphs}

    accepted_ids, stats, _coverage = pipeline._filter_and_store([candidate], run_id="excerpt-test")
    assert stats["accepted"] == 1
    stored = pipeline.list_candidates(limit=10)
    assert stored[0]["fullTextAllowed"] is True

    cluster_ids = pipeline._cluster(accepted_ids)
    generated = await pipeline._materialize_original_articles(cluster_ids)
    assert generated == 1
    with pipeline.database.session() as session:
        article = session.scalar(select(ArticleVariant))
        assert article is not None
        assert article.content_mode == "original_excerpt"
        assert len(article.paragraphs) >= 3
        assert article.review_status == "approved"


def test_rss_markup_preserves_html_paragraphs():
    item = ET.fromstring(
        "<item><description><p>First paragraph with enough English words for the reader excerpt.</p>"
        "<p>Second paragraph continues with another complete thought for careful science readers.</p>"
        "</description></item>"
    )
    markup = RssAdapter._markup(item, ["description"])
    assert "<p>" in markup
    paragraphs = paragraphs_from_html(markup)
    assert len(paragraphs) >= 2


def test_article_html_drops_nav_chrome():
    raw = """
    <html><body>
      <nav>Share this Follow us on privacy policy</nav>
      <article>
        <p>NASA researchers describe a new observatory that can watch stellar wind as it leaves a nearby star.</p>
        <p>The team combined images from several telescopes and compared the results with earlier measurements of the same system.</p>
        <p>They say the method will help scientists understand how young planets keep or lose their atmospheres over time.</p>
      </article>
    </body></html>
    """
    paragraphs = paragraphs_from_article_html(raw)
    assert len(paragraphs) >= 3
    assert all("privacy policy" not in item.lower() for item in paragraphs)


def test_publish_mixes_original_news_with_complete_stories(pipeline):
    target = date(2026, 9, 20)
    now = datetime.now(timezone.utc)
    with pipeline.database.session() as session:
        for index, topic in enumerate(TOPICS[:5]):
            candidate = ContentCandidate(
                source_id="crossref-api",
                external_id=f"mix-story-{index}",
                canonical_url=f"https://example.org/mix-story/{index}",
                title=f"Complete learning story {index}",
                summary="A reliable source summary with enough evidence and context for careful reading.",
                authors=["Editorial Team"],
                source_published_at=now,
                topic=topic,
                content_kind="paper",
                peer_review_status="peer_reviewed",
                source_tier="A",
                license="metadata indexing allowed",
                full_text_allowed=False,
                raw_hash=f"mix-raw-{index}",
                title_fingerprint=f"mix-title-{index}",
                quality_score=94,
                status="accepted",
            )
            session.add(candidate)
            session.flush()
            cluster = StoryCluster(
                topic=topic,
                canonical_title=candidate.title,
                candidate_ids=[candidate.id],
                independent_source_ids=["crossref-api"],
                evidence_score=94,
                risk_level="low",
                status="ready",
            )
            session.add(cluster)
            session.flush()
            for level in ("A2", "B1", "B2", "C1"):
                session.add(ArticleVariant(
                    story_cluster_id=cluster.id,
                    source_candidate_id=candidate.id,
                    title=f"{candidate.title} · {level}",
                    summary="完整的中文导读摘要。",
                    paragraphs=["A complete opening.", "A connected body.", "A closed conclusion."],
                    sentence_translations={},
                    glossary=[],
                    body_hash=f"mix-body-{index}-{level}",
                    cefr=level,
                    word_count=300,
                    reading_minutes=3,
                    topic=topic,
                    peer_review_status="peer_reviewed",
                    quality_score=92,
                    difficulty_metrics={"estimatedCefr": level},
                    source_published_at=now,
                    sources=[{"label": "crossref-api", "url": candidate.canonical_url}],
                    risk_flags=[],
                    review_status="approved",
                ))
        news_candidate = ContentCandidate(
            source_id="nasa-rss",
            external_id="mix-nasa",
            canonical_url="https://www.nasa.gov/news/mix",
            title="A New Space Observatory Watches Stellar Wind",
            summary="NASA reports a new way to watch stellar wind.",
            authors=["NASA"],
            source_published_at=now,
            topic="科技",
            content_kind="news",
            peer_review_status="not_applicable",
            source_tier="A",
            license="US government work",
            full_text_allowed=True,
            raw_hash="mix-nasa",
            title_fingerprint="mix-nasa",
            quality_score=93,
            status="accepted",
        )
        session.add(news_candidate)
        session.flush()
        news_cluster = StoryCluster(
            topic="科技",
            canonical_title=news_candidate.title,
            candidate_ids=[news_candidate.id],
            independent_source_ids=["nasa-rss"],
            evidence_score=90,
            risk_level="low",
            status="ready",
        )
        session.add(news_cluster)
        session.flush()
        session.add(ArticleVariant(
            story_cluster_id=news_cluster.id,
            source_candidate_id=news_candidate.id,
            title=news_candidate.title,
            summary="NASA 如何观测星风。",
            intro_zh="NASA 发布新观测方法，帮助读者理解恒星风如何影响年轻行星的大气。",
            paragraphs=["A complete opening about stellar wind.", "A connected body with evidence.", "A closed conclusion for readers."],
            sentence_translations={},
            glossary=[],
            body_hash="mix-nasa-body",
            cefr="B1",
            word_count=280,
            reading_minutes=3,
            topic="科技",
            content_mode="original_excerpt",
            peer_review_status="not_applicable",
            quality_score=93,
            difficulty_metrics={"estimatedCefr": "B1"},
            source_published_at=now,
            sources=[{"label": "NASA News", "url": news_candidate.canonical_url}],
            risk_flags=[],
            review_status="approved",
        ))

    published = pipeline.publish_today(target)
    assert published >= 4
    with pipeline.database.session() as session:
        edition = session.get(DailyEdition, target)
        titles = [
            session.get(ArticleVariant, article_id).title
            for article_id in edition.article_ids
        ]
        assert any("Stellar Wind" in title for title in titles)
