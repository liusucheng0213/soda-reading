import asyncio
import json
import os

os.environ["MODEL_CENTER_PATH"] = ":memory:"

import httpx
import pytest

from app import provider_config
from app.content_editorial import EditorialGateway
from app.model_center import BudgetExceeded, ModelCenterStore
from app.provider_config import (
    Provider,
    public_config,
    provider_definitions,
    save_overrides,
    task_provider_order,
)
from app.settings import Settings
from app.translation import TranslationGateway


@pytest.fixture
def isolated_overrides(tmp_path, monkeypatch):
    path = tmp_path / "provider_overrides.json"
    monkeypatch.setattr(provider_config, "OVERRIDES_PATH", path)
    return path


def settings_with_keys():
    return Settings(
        zhipu_api_key="zhipu-test",
        modelscope_access_token="modelscope-test",
        deepseek_api_key="deepseek-test",
        translation_provider_order="deepseek",
        editorial_provider_order="deepseek,zhipu",
    )


def test_tasks_have_independent_routes_and_custom_provider_is_shared(isolated_overrides):
    payload = {
        "order": ["zhipu"],
        "routes": {
            "translation": ["zhipu"],
            "content_moderation": ["modelscope"],
            "daily_article": ["custom-lab"],
        },
        "providers": [{
            "id": "custom-lab",
            "kind": "openai",
            "baseUrl": "https://lab.invalid/v1",
            "model": "lab-model",
            "apiKey": "fake-test-key",
        }],
    }
    save_overrides(payload)
    settings = settings_with_keys()

    assert task_provider_order("translation", settings) == ["zhipu"]
    assert task_provider_order("content_moderation", settings) == ["modelscope"]
    assert task_provider_order("daily_article", settings) == ["custom-lab"]
    assert provider_definitions(settings)["custom-lab"].model == "lab-model"
    assert "fake-test-key" not in json.dumps(public_config())
    assert public_config()["order"] == ["zhipu"]


def test_gateways_use_their_own_routes_and_share_custom_definitions(isolated_overrides):
    save_overrides({
        "routes": {"translation": ["zhipu"], "daily_article": ["custom-lab"]},
        "providers": [{
            "id": "custom-lab",
            "kind": "openai",
            "baseUrl": "https://lab.invalid/v1",
            "model": "lab-model",
            "apiKey": "fake-test-key",
        }],
    })
    settings = Settings(
        zhipu_api_key="zhipu-test",
        paid_provider_enabled=True,
        daily_paid_budget_cny=1,
        paid_request_max_cny=1,
    )

    translation = TranslationGateway(settings)
    editorial = EditorialGateway(settings)
    assert [provider.name for provider in translation.providers] == ["zhipu"]
    assert [provider.name for provider in editorial.providers] == ["custom-lab"]
    assert editorial.providers[0].base_url == "https://lab.invalid/v1"


@pytest.mark.parametrize("routes", [
    {"unknown_task": ["deepseek"]},
    {"translation": ["deepseek", "deepseek"]},
    {"translation": ["missing-provider"]},
])
def test_rejects_invalid_task_routes(isolated_overrides, routes):
    with pytest.raises(ValueError, match="路由|提供方"):
        save_overrides({"routes": routes, "providers": []})


def test_duplicate_provider_ids_are_rejected_without_overwriting(isolated_overrides):
    with pytest.raises(ValueError, match="重复"):
        save_overrides({"providers": [
            {"id": "duplicate", "model": "first-model"},
            {"id": "DUPLICATE", "model": "second-model"},
        ]})

    assert not isolated_overrides.exists()


@pytest.mark.parametrize("provider_id", ["zhipu", "modelscope", "siliconflow"])
def test_changing_a_free_preset_model_requires_the_paid_guard(isolated_overrides, provider_id):
    save_overrides({"providers": [{"id": provider_id, "model": "hypothetical-paid-model"}]})

    provider = provider_definitions(Settings())[provider_id]
    assert provider.may_charge is True
    assert provider.billing_class == "unverified_model"


@pytest.mark.parametrize(("setting", "provider_id"), [
    ("zhipu_model", "zhipu"),
    ("modelscope_model", "modelscope"),
    ("siliconflow_model", "siliconflow"),
])
def test_non_default_free_provider_settings_require_the_paid_guard(setting, provider_id):
    provider = provider_definitions(Settings(**{setting: "hypothetical-paid-model"}))[provider_id]
    assert provider.may_charge is True
    assert provider.billing_class == "unverified_model"


def test_changing_a_free_preset_endpoint_requires_the_paid_guard(isolated_overrides):
    save_overrides({"providers": [{"id": "zhipu", "baseUrl": "https://paid-gateway.invalid/v1"}]})

    provider = provider_definitions(Settings(zhipu_api_key=""))["zhipu"]
    assert provider.may_charge is True
    assert provider.billing_class == "unverified_endpoint"


@pytest.mark.asyncio
async def test_invalid_editorial_results_release_reservations_and_record_failures(isolated_overrides):
    store = ModelCenterStore()
    settings = Settings(
        deepseek_api_key="deepseek-test", editorial_provider_order="deepseek",
        paid_provider_enabled=True, daily_paid_budget_cny=1, paid_request_max_cny=1,
    )
    gateway = EditorialGateway(settings, store=store)

    async def invalid_intro(*_args):
        reservation = await store.reserve("daily_article", "deepseek", 0.01, 1, 1)
        return {"introZh": "too short", "_reservation": reservation}

    gateway._call_intro = invalid_intro
    result = await gateway.intro_zh(title="Reading", source="Example", topic="文化", paragraphs=["A paragraph."])
    assert "未改写" in result
    assert store.reserved_today_cny() == 0
    assert store.usage_summary()["daily_article"]["failures"] == 1

    async def invalid_article(*_args):
        reservation = await store.reserve("daily_article", "deepseek", 0.01, 1, 1)
        return {"title": "Incomplete", "_reservation": reservation}

    gateway.cooldown_until.clear()
    gateway._call = invalid_article
    with pytest.raises(Exception, match="不可用"):
        await gateway.generate("文化", "B1", [])
    assert store.reserved_today_cny() == 0
    assert store.usage_summary()["daily_article"]["failures"] == 2


@pytest.mark.asyncio
async def test_cancelled_translation_creator_keeps_shared_task_and_caches_result(isolated_overrides):
    gateway = TranslationGateway(Settings(zhipu_api_key="test", translation_provider_order="zhipu"))
    started = asyncio.Event()
    finish = asyncio.Event()
    calls = []

    async def slow_result(*_args):
        calls.append("zhipu")
        started.set()
        await finish.wait()
        return {"translation": "河岸"}

    gateway._call_provider = slow_result
    payload = {"word": "bank", "sentence": "We sat on the river bank."}
    creator = asyncio.create_task(gateway.translate("word", payload))
    await started.wait()
    creator.cancel()
    with pytest.raises(asyncio.CancelledError):
        await creator
    assert gateway.inflight

    follower = asyncio.create_task(gateway.translate("word", payload))
    await asyncio.sleep(0)
    finish.set()
    assert (await follower)["coalesced"] is True
    cached = await gateway.translate("word", payload)
    assert cached["cacheLayer"] == "memory"
    assert calls == ["zhipu"]
    assert gateway.inflight == {}


def test_content_service_can_share_persistent_model_store(tmp_path):
    from app.content import ContentService

    store = ModelCenterStore(tmp_path / "shared.db")
    settings = Settings(database_url=f"sqlite:///{tmp_path / 'content.db'}", editorial_provider_order="")
    service = ContentService(settings, model_store=store)
    assert service.pipeline.editorial.store is store


def test_partial_config_update_preserves_translation_route(isolated_overrides):
    from fastapi.testclient import TestClient
    from app import main as main_module

    save_overrides({"routes": {"translation": ["zhipu"]}})
    response = TestClient(main_module.app).put("/admin/providers/config", json={
        "routes": {"daily_article": ["zhipu"]},
    })
    assert response.status_code == 200
    assert public_config()["routes"]["translation"] == ["zhipu"]
    assert public_config()["routes"]["daily_article"] == ["zhipu"]


def test_invalid_config_returns_a_safe_422(isolated_overrides):
    from fastapi.testclient import TestClient
    from app import main as main_module

    response = TestClient(main_module.app).put("/admin/providers/config", json={"providers": [
        {"id": "duplicate", "model": "first"},
        {"id": "DUPLICATE", "model": "second"},
    ]})
    assert response.status_code == 422
    assert response.json()["detail"] == "提供方 ID 重复"


def test_custom_paid_route_stays_blocked_by_default(isolated_overrides):
    save_overrides({
        "routes": {"translation": ["custom-paid"]},
        "providers": [{
            "id": "custom-paid",
            "kind": "openai",
            "baseUrl": "https://paid.invalid/v1",
            "model": "paid-model",
            "apiKey": "fake-test-key",
            "cheapApi": True,
        }],
    })
    gateway = TranslationGateway(Settings(paid_provider_enabled=True, daily_paid_budget_cny=0))
    assert gateway.providers == []


def test_shared_provider_shape_matches_existing_gateway_contract():
    provider = Provider("custom", "openai", "https://lab.invalid/v1", "lab-model", api_key="key")
    assert provider.configured is True
    assert provider.may_charge is False


@pytest.mark.asyncio
async def test_shared_budget_survives_reopen_and_releases_failure(tmp_path):
    store = ModelCenterStore(tmp_path / "center.db")
    translation_reservation = await store.reserve("translation", "deepseek", 0.4, 1.0, 0.5)
    await store.reserve("daily_article", "deepseek", 0.4, 1.0, 0.5)
    with pytest.raises(BudgetExceeded):
        await store.reserve("content_moderation", "deepseek", 0.3, 1.0, 0.5)
    with pytest.raises(BudgetExceeded):
        await store.reserve("translation", "deepseek", 0.6, 2.0, 0.5)
    await store.release(translation_reservation)

    reopened = ModelCenterStore(tmp_path / "center.db")
    assert reopened.reserved_today_cny() == pytest.approx(0.4)


@pytest.mark.asyncio
async def test_usage_is_grouped_by_task_and_survives_reopen(tmp_path):
    store = ModelCenterStore(tmp_path / "center.db")
    await store.record_usage("translation", "zhipu", "glm-test", True, 24, 7, True, 0)
    await store.record_usage("translation", "zhipu", "glm-test", False, 18, 0, False, 0)
    await store.record_usage("daily_article", "custom", "lab", True, 100, 40, False, 0.02)

    reopened = ModelCenterStore(tmp_path / "center.db")
    summary = reopened.usage_summary()
    assert summary["translation"] == {
        "attempts": 2,
        "successes": 1,
        "failures": 1,
        "inputTokens": 24,
        "outputTokens": 7,
        "estimatedInputTokens": 18,
        "estimatedOutputTokens": 0,
        "estimatedCny": 0,
    }
    assert summary["daily_article"]["estimatedInputTokens"] == 100
    assert summary["daily_article"]["estimatedOutputTokens"] == 40
    assert summary["daily_article"]["estimatedCny"] == pytest.approx(0.02)
    assert summary["content_moderation"]["attempts"] == 0


def test_gateways_accept_a_shared_store_without_touching_real_files(isolated_overrides):
    store = ModelCenterStore()
    settings = Settings()
    assert TranslationGateway(settings, store=store).store is store
    assert EditorialGateway(settings, store=store).store is store


@pytest.mark.asyncio
async def test_translation_cache_survives_reopen_and_route_change(isolated_overrides, tmp_path):
    path = tmp_path / "center.db"
    first = TranslationGateway(
        Settings(zhipu_api_key="zhipu-test", translation_provider_order="zhipu"),
        store=ModelCenterStore(path),
    )
    calls = []

    async def fake_zhipu_result(*_args):
        calls.append("zhipu")
        return {"translation": "河岸", "lemma": "bank"}

    first._call_provider = fake_zhipu_result
    payload = {"word": "bank", "sentence": "We sat on the river bank."}
    await first.translate("word", payload)

    second = TranslationGateway(
        Settings(deepseek_api_key="deepseek-test", translation_provider_order="deepseek"),
        store=ModelCenterStore(path),
    )
    forbidden_calls = []

    async def forbidden_cloud_call(*_args):
        forbidden_calls.append("deepseek")
        return {"translation": "不应调用"}

    second._call_provider = forbidden_cloud_call
    cached = await second.translate("word", payload)
    assert cached["cacheLayer"] == "disk"
    assert cached["translation"] == "河岸"
    assert forbidden_calls == []
    assert (await second.translate("word", payload))["cacheLayer"] == "memory"
    assert second.overview()["cache"]["diskHits"] == 1
    assert second.overview()["cache"]["diskEntries"] == 1


@pytest.mark.asyncio
async def test_cache_expiry_and_clear_preserve_usage(tmp_path):
    store = ModelCenterStore(tmp_path / "center.db")
    store.cache_set("expired", {"translation": "过期"}, 0)
    assert store.cache_get("expired") is None
    store.cache_set("valid", {"translation": "有效"}, 60)
    await store.record_usage("translation", "zhipu", "test", True, 1, 1, True, 0)

    assert store.cache_clear() == 1
    assert store.cache_entries() == 0
    assert store.usage_summary()["translation"]["successes"] == 1


def test_delete_cache_endpoint_clears_memory_and_disk(monkeypatch):
    from fastapi.testclient import TestClient
    from app import main as main_module

    store = ModelCenterStore()
    gateway = TranslationGateway(Settings(translation_provider_order=""), store=store)
    gateway.cache["memory-key"] = (9999999999, {"translation": "内存"})
    store.cache_set("disk-key", {"translation": "磁盘"}, 60)
    gateway.failure_cache["negative"] = 9999999999
    monkeypatch.setattr(main_module, "gateway", gateway)
    client = TestClient(main_module.app)

    response = client.delete("/admin/translation/cache")
    assert response.status_code == 200
    assert response.json()["cleared"] == 1
    assert response.json()["overview"]["cache"]["diskEntries"] == 0
    assert gateway.cache == {}
    assert store.cache_entries() == 0
    assert gateway.failure_cache["negative"] == 9999999999


@pytest.mark.asyncio
async def test_usage_distinguishes_reported_and_estimated_tokens(isolated_overrides):
    gateway = TranslationGateway(Settings(zhipu_api_key="test", translation_provider_order="zhipu"))

    async def reported(*_args):
        return {"translation": "河岸", "_usage": {"input_tokens": 24, "output_tokens": 7}}

    gateway._call_provider = reported
    result = await gateway.translate("word", {"word": "bank", "sentence": "We sat on the river bank."})
    assert "_usage" not in result
    usage = gateway.overview()["tasks"]["translation"]
    assert usage["inputTokens"] == 24
    assert usage["outputTokens"] == 7
    assert usage["successes"] == 1
    assert usage["estimatedInputTokens"] == 0


@pytest.mark.asyncio
async def test_missing_usage_is_estimated_and_failure_has_no_fake_cost(isolated_overrides):
    gateway = TranslationGateway(Settings(zhipu_api_key="test", translation_provider_order="zhipu"))

    async def unreported(*_args):
        return {"translation": "银行"}

    gateway._call_provider = unreported
    await gateway.translate("word", {"word": "bank", "sentence": "The bank approved the loan."})

    async def failed(*_args):
        raise RuntimeError("synthetic provider failure")

    gateway._call_provider = failed
    with pytest.raises(RuntimeError):
        await gateway.translate("word", {"word": "bank", "sentence": "A different bank sentence."})
    usage = gateway.overview()["tasks"]["translation"]
    assert usage["inputTokens"] == 0
    assert usage["outputTokens"] == 0
    assert usage["estimatedInputTokens"] > 0
    assert usage["estimatedOutputTokens"] > 0
    assert usage["failures"] == 1
    assert usage["estimatedCny"] == 0


@pytest.mark.asyncio
async def test_openai_response_usage_is_captured(isolated_overrides):
    import httpx

    gateway = TranslationGateway(Settings(zhipu_api_key="test", translation_provider_order="zhipu"))

    class FakeHttp:
        async def post(self, _url, **_kwargs):
            return httpx.Response(200, request=httpx.Request("POST", "https://provider.invalid"), json={
                "choices": [{"message": {"content": '{"translation":"河岸"}'}}],
                "usage": {"prompt_tokens": 24, "completion_tokens": 7},
            })

    gateway._http = FakeHttp()
    provider = provider_definitions(Settings())["zhipu"]
    result = await gateway._call_openai_compatible(provider, "word", {"word": "bank", "sentence": "River bank."})
    assert result["_usage"] == {"input_tokens": 24, "output_tokens": 7}


@pytest.mark.asyncio
async def test_editorial_usage_is_recorded_under_daily_article(isolated_overrides, monkeypatch):
    import httpx

    gateway = EditorialGateway(Settings(zhipu_api_key="test", editorial_provider_order="zhipu"))

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, _url, **_kwargs):
            return httpx.Response(200, request=httpx.Request("POST", "https://provider.invalid"), json={
                "choices": [{"message": {"content": '{"introZh":"这篇文章介绍城市阅读空间如何帮助读者理解社区。"}'}}],
                "usage": {"prompt_tokens": 40, "completion_tokens": 8},
            })

    monkeypatch.setattr("app.content_editorial.httpx.AsyncClient", FakeClient)
    result = await gateway.intro_zh(
        title="Reading in the City",
        source="Example",
        topic="文化",
        paragraphs=["Libraries create space for reading and conversation."],
    )
    assert "阅读空间" in result
    usage = gateway.store.usage_summary()["daily_article"]
    assert usage["inputTokens"] == 40
    assert usage["outputTokens"] == 8
    assert usage["successes"] == 1


@pytest.mark.asyncio
async def test_hedged_translation_cancellation_releases_reservation_before_success(isolated_overrides):
    store = ModelCenterStore()
    gateway = TranslationGateway(Settings(
        paid_provider_enabled=True,
        daily_paid_budget_cny=1,
        paid_request_max_cny=1,
        paid_fallback_mode="automatic",
        deepseek_api_key="deepseek-test",
        zhipu_api_key="zhipu-test",
        translation_provider_order="deepseek,zhipu",
    ), store=store)

    async def slow_or_fast(provider, *_args):
        if provider.name == "deepseek":
            await asyncio.sleep(30)
        return {"translation": "河岸"}

    gateway._call_provider = slow_or_fast
    result = await gateway.translate("word", {"word": "bank", "sentence": "We sat on the river bank."})
    assert result["provider"] == "zhipu"
    assert store.reserved_today_cny() == 0
    assert store.usage_summary()["translation"]["attempts"] == 1


@pytest.mark.asyncio
async def test_cancelled_editorial_post_releases_reservation(isolated_overrides, monkeypatch):
    store = ModelCenterStore()
    gateway = EditorialGateway(Settings(
        paid_provider_enabled=True,
        daily_paid_budget_cny=1,
        paid_request_max_cny=1,
        deepseek_api_key="deepseek-test",
        editorial_provider_order="deepseek",
    ), store=store)
    started = asyncio.Event()

    class SlowClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, _url, **_kwargs):
            started.set()
            await asyncio.sleep(30)

    monkeypatch.setattr("app.content_editorial.httpx.AsyncClient", SlowClient)
    provider = gateway.providers[0]
    task = asyncio.create_task(gateway._post(provider, {"model": provider.model, "messages": [], "max_tokens": 100}))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert store.reserved_today_cny() == 0
    assert store.usage_summary()["daily_article"]["attempts"] == 0


@pytest.mark.asyncio
async def test_editorial_400_failure_releases_original_estimate(isolated_overrides, monkeypatch):
    store = ModelCenterStore()
    gateway = EditorialGateway(Settings(
        paid_provider_enabled=True,
        daily_paid_budget_cny=1,
        paid_request_max_cny=1,
        deepseek_api_key="deepseek-test",
        editorial_provider_order="deepseek",
    ), store=store)
    calls = []

    class FailedClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, url, **_kwargs):
            calls.append(url)
            request = httpx.Request("POST", url)
            if len(calls) == 1:
                return httpx.Response(400, request=request)
            return httpx.Response(500, request=request)

    monkeypatch.setattr("app.content_editorial.httpx.AsyncClient", FailedClient)
    provider = gateway.providers[0]
    body = {"model": provider.model, "messages": [], "max_tokens": 100, "response_format": {"type": "json_object"}}
    with pytest.raises(httpx.HTTPStatusError):
        await gateway._post(provider, body)
    assert store.reserved_today_cny() == 0
    assert body["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_editorial_400_success_keeps_original_cost_and_only_reserves_once(isolated_overrides, monkeypatch):
    store = ModelCenterStore()
    gateway = EditorialGateway(Settings(
        paid_provider_enabled=True,
        daily_paid_budget_cny=1,
        paid_request_max_cny=1,
        deepseek_api_key="deepseek-test",
        editorial_provider_order="deepseek",
    ), store=store)
    calls = []
    original_estimates = []

    class RetryClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, url, **_kwargs):
            calls.append(url)
            request = httpx.Request("POST", url)
            if len(calls) == 1:
                original_estimates.append(gateway._estimated_paid_cost(provider, _kwargs["json"]))
                return httpx.Response(400, request=request)
            return httpx.Response(200, request=request, json={
                "choices": [{"message": {"content": '{"introZh":"这篇文章介绍城市阅读空间如何帮助读者理解社区。"}'}}],
            })

    monkeypatch.setattr("app.content_editorial.httpx.AsyncClient", RetryClient)
    provider = gateway.providers[0]
    body = {"model": provider.model, "messages": [], "max_tokens": 100, "response_format": {"type": "json_object"}}
    result = await gateway.intro_zh(title="Reading", source="Example", topic="文化", paragraphs=["Libraries create space for reading."])
    assert "阅读空间" in result
    assert store.reserved_today_cny() == pytest.approx(original_estimates[0])
    assert store.usage_summary()["daily_article"]["estimatedCny"] == pytest.approx(original_estimates[0])


@pytest.mark.asyncio
async def test_release_uses_reservation_day_across_midnight(tmp_path):
    store = ModelCenterStore(tmp_path / "center.db")
    store._day = lambda: "2026-11-14"
    reservation = await store.reserve("translation", "deepseek", 0.4, 1.0, 0.5)
    store._day = lambda: "2026-11-15"
    await store.release(reservation)
    store._day = lambda: "2026-11-14"
    assert store.reserved_today_cny() == 0


@pytest.mark.parametrize("usage", [
    {},
    {"prompt_tokens": 24},
    {"prompt_tokens": "invalid", "completion_tokens": 7},
])
@pytest.mark.asyncio
async def test_empty_or_partial_usage_falls_back_to_estimates(isolated_overrides, usage):
    gateway = TranslationGateway(Settings(zhipu_api_key="test", translation_provider_order="zhipu"))

    class FakeHttp:
        async def post(self, _url, **_kwargs):
            return httpx.Response(200, request=httpx.Request("POST", "https://provider.invalid"), json={
                "choices": [{"message": {"content": '{"translation":"河岸"}'}}],
                "usage": usage,
            })

    gateway._http = FakeHttp()
    provider = provider_definitions(Settings())["zhipu"]
    result = await gateway._call_openai_compatible(provider, "word", {"word": "bank", "sentence": "River bank."})
    assert "_usage" not in result


@pytest.mark.asyncio
async def test_disabled_tencent_is_not_configured_and_never_called(isolated_overrides):
    save_overrides({"providers": [{"id": "tencent", "enabled": False}]})
    settings = Settings(
        tencent_secret_id="configured-id",
        tencent_secret_key="configured-key",
        tencent_free_quota_guarded=True,
        translation_provider_order="tencent",
    )
    definitions = provider_definitions(settings)
    assert definitions["tencent"].configured is False
    gateway = TranslationGateway(settings)
    calls = []

    async def forbidden(*_args):
        calls.append("tencent")
        return {"translation": "不应调用"}

    gateway._call_provider = forbidden
    with pytest.raises(RuntimeError):
        await gateway.translate("word", {"word": "unknown", "sentence": "This must stay offline."})
    assert calls == []
