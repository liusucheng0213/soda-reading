import asyncio
import os

os.environ["MODEL_CENTER_PATH"] = ":memory:"

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.main import app
from app.settings import Settings
from app.translation import TranslationGateway, TranslationUnavailable


client = TestClient(app)


@pytest.fixture(autouse=True)
def isolate_tests_from_real_cloud_credentials(monkeypatch):
    """Unit tests must be deterministic and must never consume a user's API quota."""
    offline_gateway = TranslationGateway(
        Settings(
            modelscope_access_token="",
            zhipu_api_key="",
            siliconflow_api_key="",
            tencent_secret_id="",
            tencent_secret_key="",
            dashscope_api_key="",
            deepseek_api_key="",
            translation_provider_order="",
        )
    )
    monkeypatch.setattr(main_module, "gateway", offline_gateway)


def test_local_feed_and_preferences():
    feed = client.get(
        "/feed/daily",
        params={"level": "B1", "topics": "文化"},
    )
    assert feed.status_code == 200
    assert feed.json()["primary"]["publishedAt"]
    assert len(feed.json()["alternatives"]) >= 2


def test_feed_switches_primary_article_with_cefr():
    a2 = client.get(
        "/feed/daily",
        params={"level": "A2", "topics": "文化"},
    ).json()
    b2 = client.get(
        "/feed/daily",
        params={"level": "B2", "topics": "文化"},
    ).json()
    assert a2["primary"]["cefr"] == "A2"
    assert b2["primary"]["cefr"] == "B2"
    assert a2["primary"]["id"] != b2["primary"]["id"]
    assert a2["primary"]["paragraphs"]
    assert b2["primary"]["paragraphs"]


def test_word_and_sentence_local_fallback():
    word = client.post(
        "/translations/word",
        json={"word": "seeking", "sentence": "Readers are seeking something real.", "targetLanguage": "zh-CN"},
    )
    assert word.status_code == 200
    assert word.json()["translation"] == "寻求"
    assert word.json()["commonTranslation"] == "寻找"
    assert word.json()["quality"] == "basic"
    sentence = client.post(
        "/translations/sentence",
        json={"sentence": "Independent bookstores are becoming places where people meet, read, and grow together.", "targetLanguage": "zh-CN"},
    )
    assert sentence.status_code == 200
    assert "独立书店" in sentence.json()["translation"]


@pytest.mark.asyncio
async def test_dictionary_fallback_is_not_cached_for_a_month():
    gateway = TranslationGateway(Settings(translation_provider_order=""))
    payload = {"word": "infrastructure", "sentence": "A public library is infrastructure."}
    first = await gateway.translate("word", payload)
    assert first["provider"] == "local-corpus"
    assert first["translation"] == "基础结构"
    assert gateway.cache == {}
    second = await gateway.translate("word", payload)
    assert second["cacheLayer"] == "local"
    assert gateway.cache == {}


def test_unknown_word_never_returns_placeholder_translation():
    response = client.post(
        "/translations/word",
        json={"word": "unlistedword", "sentence": "This unlistedword is only used for testing.", "targetLanguage": "zh-CN"},
    )
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "TRANSLATION_UNAVAILABLE",
        "message": "当前翻译服务暂时不可用，请稍后重试",
        "retryable": True,
    }


@pytest.mark.asyncio
async def test_cloud_model_returns_contextual_and_common_senses():
    gateway = TranslationGateway(
        Settings(
            zhipu_api_key="zhipu-test",
            translation_provider_order="zhipu",
        )
    )
    calls = []

    async def fake_call(provider, _scope, _payload):
        calls.append(provider.name)
        return {
            "translation": "河岸",
            "commonTranslation": "银行",
            "lemma": "bank",
            "partOfSpeech": "n.",
            "phonetic": "/bæŋk/",
        }

    gateway._call_provider = fake_call
    result = await gateway.translate(
        "word",
        {"word": "bank", "sentence": "We sat on the river bank.", "before": "", "after": ""},
    )
    assert calls == ["zhipu"]
    assert result["provider"] == "zhipu"
    assert result["translation"] == "河岸"
    assert result["commonTranslation"] == "银行"
    assert result["quality"] == "contextual"


@pytest.mark.asyncio
async def test_timeout_falls_through_to_next_contextual_provider():
    gateway = TranslationGateway(
        Settings(
            zhipu_api_key="zhipu-test",
            siliconflow_api_key="siliconflow-test",
            translation_provider_order="zhipu,siliconflow",
            translation_provider_timeout_ms=500,
            translation_total_timeout_ms=1200,
        )
    )
    calls = []

    async def fake_call(provider, scope, payload):
        calls.append(provider.name)
        if provider.name == "zhipu":
            raise asyncio.TimeoutError
        meaning = "河岸" if "river" in payload["sentence"] else "银行"
        return {
            "translation": meaning,
            "commonTranslation": "银行",
            "lemma": "bank",
            "partOfSpeech": "n.",
            "phonetic": "/bæŋk/",
        }

    gateway._call_provider = fake_call
    result = await gateway.translate(
        "word",
        {"word": "bank", "sentence": "We sat on the river bank.", "before": "", "after": ""},
    )
    assert calls == ["zhipu", "siliconflow"]
    assert result["translation"] == "河岸"
    assert result["commonTranslation"] == "银行"
    assert result["quality"] == "contextual"
    assert result["provider"] == "siliconflow"
    assert gateway.metrics["zhipu"]["timeouts"] == 1


@pytest.mark.asyncio
async def test_rate_limited_provider_enters_cooldown():
    gateway = TranslationGateway(
        Settings(
            zhipu_api_key="zhipu-test",
            siliconflow_api_key="siliconflow-test",
            translation_provider_order="zhipu,siliconflow",
        )
    )
    calls = []

    async def fake_call(provider, _scope, _payload):
        calls.append(provider.name)
        if provider.name == "zhipu":
            request = httpx.Request("POST", "https://open.bigmodel.cn/api/paas/v4/chat/completions")
            response = httpx.Response(429, request=request)
            raise httpx.HTTPStatusError("rate limited", request=request, response=response)
        return {"translation": "银行", "lemma": "bank", "partOfSpeech": "n.", "phonetic": "/bæŋk/"}

    gateway._call_provider = fake_call
    first = await gateway.translate(
        "word",
        {"word": "bank", "sentence": "The bank approved the loan.", "before": "", "after": ""},
    )
    second = await gateway.translate(
        "word",
        {"word": "bank", "sentence": "The bank opened early today.", "before": "", "after": ""},
    )

    assert first["provider"] == "siliconflow"
    assert second["provider"] == "siliconflow"
    assert calls == ["zhipu", "siliconflow", "siliconflow"]
    assert gateway.metrics["zhipu"]["rateLimited"] == 1
    assert gateway.metrics["zhipu"]["status"] == "cooldown"


@pytest.mark.asyncio
async def test_all_invalid_provider_results_fail_honestly():
    gateway = TranslationGateway(
        Settings(zhipu_api_key="zhipu-test", translation_provider_order="zhipu")
    )

    async def invalid_result(*_args):
        return {"translation": "语境释义"}

    gateway._call_provider = invalid_result
    with pytest.raises(TranslationUnavailable):
        await gateway.translate(
            "word",
            {"word": "bank", "sentence": "The bank approved the loan.", "before": "", "after": ""},
        )


@pytest.mark.asyncio
async def test_identical_concurrent_requests_share_one_provider_call():
    gateway = TranslationGateway(
        Settings(
            zhipu_api_key="zhipu-test",
            translation_provider_order="zhipu",
            translation_failure_ttl_seconds=0,
        )
    )
    calls = 0

    async def delayed_result(*_args):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.03)
        return {
            "translation": "专刊",
            "lemma": "issue",
            "partOfSpeech": "n.",
            "phonetic": "/ˈɪʃuː/",
        }

    gateway._call_provider = delayed_result
    payload = {
        "word": "issue",
        "sentence": "The journal published a special issue on climate adaptation.",
        "before": "",
        "after": "",
    }
    first, second = await asyncio.gather(
        gateway.translate("word", payload),
        gateway.translate("word", payload),
    )
    cached = await gateway.translate("word", payload)

    assert calls == 1
    assert first["translation"] == second["translation"] == "专刊"
    assert first.get("coalesced") is True or second.get("coalesced") is True
    assert cached["cached"] is True
    assert gateway.overview()["cache"]["coalesced"] == 1


def test_source_policy_only_allows_licensed_full_text():
    licensed = {
        "soda-editorial",
        "nasa-rss",
        "nsf-rss",
        "energy-gov-rss",
        "noaa-rss",
        "usgs-rss",
        "federal-reserve-rss",
        "the-conversation-atom",
        "wikipedia-featured",
        "zhwiki-featured",
        "gutenberg-popular",
    }
    policies = client.get("/admin/sources")
    assert policies.status_code == 200
    for policy in policies.json():
        if policy["id"] in licensed:
            assert policy["fullTextAllowed"] is True
        else:
            assert policy["fullTextAllowed"] is False


def test_provider_admin_status_never_exposes_secrets():
    response = client.get("/admin/providers")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
    serialized = response.text.lower()
    assert "api_key" not in serialized
    assert "secret_key" not in serialized


def test_admin_provider_config_roundtrip_masks_keys(tmp_path, monkeypatch):
    from app import provider_config

    monkeypatch.setattr(provider_config, "OVERRIDES_PATH", tmp_path / "provider_overrides.json")
    listing = client.get("/admin/providers/config")
    assert listing.status_code == 200
    assert listing.json()["providers"][0]["help"]
    saved = client.put(
        "/admin/providers/config",
        json={
            "order": ["deepseek"],
            "providers": [{
                "id": "deepseek",
                "label": "DeepSeek",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-chat",
                "apiKey": "unit-test-provider-key",
                "enabled": True,
                "cheapApi": True,
            }],
        },
    )
    assert saved.status_code == 200
    assert "unit-test-provider-key" not in saved.text
    assert saved.json()["config"]["providers"][0]["hasKey"] is True


def test_word_referent_validation_omits_dictionary_sense():
    from types import SimpleNamespace
    from app.translation import ProviderResponseError, TranslationGateway

    result = TranslationGateway._validate_result(
        "word",
        {
            "translation": "指代前文的恒星风",
            "commonTranslation": "它",
            "referent": True,
            "lemma": "it",
            "phonetic": "",
            "partOfSpeech": "pron.",
        },
        SimpleNamespace(kind="openai"),
    )
    assert result["referent"] is True
    assert result["commonTranslation"] == ""
    assert result["translation"] == "指代前文的恒星风"
    labeled = TranslationGateway._validate_result(
        "word",
        {
            "translation": "文中指代河岸",
            "commonTranslation": "它",
            "referent": False,
        },
        SimpleNamespace(kind="openai"),
    )
    assert labeled["referent"] is True
    assert labeled["commonTranslation"] == ""
    with pytest.raises(ProviderResponseError):
        TranslationGateway._validate_result(
            "word",
            {"translation": "它", "referent": True},
            SimpleNamespace(kind="openai"),
        )


def test_production_mode_protects_admin():
    previous_env = main_module.settings.app_env
    previous_token = main_module.settings.admin_api_token
    main_module.settings.app_env = "production"
    main_module.settings.admin_api_token = "admin-test-token"
    try:
        denied = client.get("/admin/providers")
        assert denied.status_code == 403
        allowed = client.get(
            "/admin/providers",
            headers={"X-Admin-Token": "admin-test-token"},
        )
        assert allowed.status_code == 200
    finally:
        main_module.settings.app_env = previous_env
        main_module.settings.admin_api_token = previous_token


def test_provider_presets_match_settings_defaults():
    from app.provider_config import PROVIDER_PRESETS

    presets = {item["id"]: item for item in PROVIDER_PRESETS}
    assert presets["deepseek"]["model"] == Settings.model_fields["deepseek_model"].default
    assert presets["zhipu"]["model"] == Settings.model_fields["zhipu_model"].default
    assert presets["modelscope"]["model"] == Settings.model_fields["modelscope_model"].default


def test_local_only_learning_state_has_no_server_write_endpoints():
    preference = client.put(
        "/profile/preferences",
        json={"level": "B1", "topics": ["文化"], "minutes": 10, "reminder": "20:30"},
    )
    progress = client.put(
        "/reading-progress",
        json={"contentId": "piece", "progress": 0.5},
    )
    vocabulary = client.post(
        "/vocabulary",
        json={"contentId": "piece", "word": "bank", "translation": "河岸", "sentence": "A river bank."},
    )
    assert preference.status_code == 404
    assert progress.status_code == 404
    assert vocabulary.status_code == 404


def test_local_feed_and_removed_auth_routes_need_no_account():
    feed = client.get("/feed/daily", params={"level": "B1", "topics": "文化"})
    assert feed.status_code == 200
    assert feed.json()["primary"]["paragraphs"]
    assert client.post("/auth/sms/send", json={"phone": "13800138000"}).status_code == 404
    assert client.post(
        "/auth/password/login", json={"username": "admin", "password": "not-needed"}
    ).status_code == 404


def test_feed_accepts_full_cefr_range_without_accounts():
    for level in ("A1", "C2"):
        response = client.get("/feed/daily", params={"level": level, "topics": "文化"})
        assert response.status_code == 200
        assert response.json()["primary"]["paragraphs"]


def test_exam_catalog_filters_tracks_and_never_enters_daily_feed(tmp_path, monkeypatch):
    import json
    from datetime import datetime
    from pathlib import Path
    from zoneinfo import ZoneInfo

    from app.content import ContentService
    from app.content_store import DailyEdition
    from app.exam_store import ExamContentStore

    settings = Settings(database_url=f"sqlite:///{tmp_path / 'exam-api.db'}", editorial_provider_order="")
    service = ContentService(settings)
    store = ExamContentStore(service.database)
    content_dir = Path(__file__).parent.parent / "content" / "exams"
    filenames = ["cet4-shady-streets.json", "cet6-soil-life.json", "postgraduate-helpful-maps.json"]
    imported = [store.import_passage(json.loads((content_dir / filename).read_text(encoding="utf-8"))) for filename in filenames]
    with service.database.session() as session:
        session.add(DailyEdition(
            edition_date=datetime.now(ZoneInfo(settings.content_timezone)).date(),
            status="published",
            article_ids=[article["id"] for article in imported],
        ))
    monkeypatch.setattr(main_module, "content_service", service)
    monkeypatch.setattr(main_module, "exam_store", store, raising=False)

    response = client.get("/exams/catalog", params={"track": "cet4"})
    assert response.status_code == 200
    items = response.json()["items"]
    assert [item["id"] for item in items] == ["cet4-shady-streets-original"]
    assert items[0]["examTrack"] == "cet4"
    assert items[0]["contentOrigin"] == "original"
    assert len(items[0]["questions"]) == 4
    assert client.get("/exams/catalog", params={"track": "ielts"}).status_code == 422
    assert client.get("/exams/catalog", params={"track": "high_school"}).status_code == 422

    feed = client.get("/feed/daily", params={"level": "B2", "topics": "自然"}).json()
    feed_items = [feed["primary"], *feed["alternatives"]]
    assert not ({item["id"] for item in feed_items} & {article["id"] for article in imported})
    assert all(item["examTrack"] is None for item in feed_items)
    assert all(item["contentOrigin"] is None for item in feed_items)
    assert all(item["questions"] == [] for item in feed_items)


def test_daily_feed_high_school_track_and_fallback(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timezone
    from pathlib import Path
    from zoneinfo import ZoneInfo

    from app.content import ContentService
    from app.content_store import ArticleVariant, DailyEdition
    from app.exam_store import ExamContentStore

    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'daily-track.db'}",
        editorial_provider_order="",
    )
    service = ContentService(settings)
    store = ExamContentStore(service.database)
    exam_dir = Path(__file__).parent.parent / "content" / "exams"
    high_dir = Path(__file__).parent.parent / "content" / "high-school"
    cet = store.import_passage(json.loads((exam_dir / "cet4-last-bus.json").read_text(encoding="utf-8")))
    high_payloads = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(high_dir.glob("*.json"))
    ]
    high = store.import_passages(high_payloads)["items"]
    with service.database.session() as session:
        cet_article = session.get(ArticleVariant, cet["id"])
        ordinary_ids = []
        for index in range(3):
            article_id = f"track-ordinary-{index}"
            ordinary_ids.append(article_id)
            session.add(ArticleVariant(
                id=article_id,
                story_cluster_id=cet_article.story_cluster_id,
                source_candidate_id=cet_article.source_candidate_id,
                title=f"Ordinary track reading {index}",
                author="苏打阅读编辑部",
                summary="普通轨道阅读导读。",
                intro_zh="普通轨道阅读导读。",
                paragraphs=["A complete opening.", "A connected body.", "A closed conclusion."],
                sentence_translations={},
                glossary=[],
                body_hash=f"track-ordinary-hash-{index}",
                cefr="B1",
                word_count=12,
                reading_minutes=2,
                topic="文化",
                content_mode="editorial_digest",
                peer_review_status="not_applicable",
                quality_score=90,
                difficulty_metrics={},
                source_published_at=datetime.now(timezone.utc),
                sources=[],
                risk_flags=[],
                review_status="approved",
                created_at=datetime.now(timezone.utc),
            ))
        today = datetime.now(ZoneInfo(settings.content_timezone)).date()
        session.add(DailyEdition(
            edition_date=today,
            status="published",
            article_ids=[cet["id"], *(item["id"] for item in high), *ordinary_ids],
        ))
    monkeypatch.setattr(main_module, "content_service", service)

    daily_response = client.get("/feed/daily", params={"level": "B1", "track": "daily"})
    assert daily_response.status_code == 200
    daily_items = [daily_response.json()["primary"], *daily_response.json()["alternatives"]]
    assert cet["id"] not in {item["id"] for item in daily_items}
    assert any(item["examTrack"] is None for item in daily_items)

    high_response = client.get("/feed/daily", params={"level": "B1", "track": "high_school"})
    assert high_response.status_code == 200
    high_items = [high_response.json()["primary"], *high_response.json()["alternatives"]]
    assert high_response.json()["primary"]["examTrack"] == "high_school"
    assert all(item["examTrack"] == "high_school" for item in high_items)
    assert all(item["paragraphs"] for item in high_items)

    daily_again = client.get("/feed/daily", params={"level": "B1", "track": "daily"}).json()
    daily_again_items = [daily_again["primary"], *daily_again["alternatives"]]
    assert any(item["examTrack"] is None for item in daily_again_items)

    fallback = client.get("/feed/daily", params={"level": "C1", "track": "high_school"})
    assert fallback.status_code == 200
    assert fallback.json()["fallback"] is True
    assert fallback.json()["primary"]["paragraphs"]
    assert fallback.json()["primary"]["examTrack"] is None
    assert client.get("/feed/daily", params={"track": "ielts"}).status_code == 422


def test_high_school_local_dictionary_supports_offline_vocabulary():
    response = client.post(
        "/translations/word",
        json={
            "word": "library",
            "sentence": "When he borrowed a library book for a history project, a folded note fell from its pages.",
            "targetLanguage": "zh-CN",
        },
    )
    assert response.status_code == 200
    assert response.json()["translation"] == "图书馆"
    assert response.json()["provider"] == "local-corpus"
