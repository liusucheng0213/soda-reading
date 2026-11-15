from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .settings import DEFAULT_DEEPSEEK_MODEL, DEFAULT_MODELSCOPE_MODEL, DEFAULT_ZHIPU_MODEL, Settings, get_settings


OVERRIDES_PATH = Path(os.environ.get(
    "PROVIDER_OVERRIDES_PATH",
    Path(__file__).resolve().parent.parent / "data" / "provider_overrides.json",
))
TASK_ROUTE_IDS = ("translation", "content_moderation", "daily_article")

PROVIDER_PRESETS = [
    {
        "id": "deepseek",
        "label": "DeepSeek",
        "kind": "openai",
        "baseUrl": "https://api.deepseek.com",
        "model": DEFAULT_DEEPSEEK_MODEL,
        "help": "在 platform.deepseek.com 创建 API Key。推荐模型 deepseek-chat，不要用 reasoner。接口地址填 https://api.deepseek.com，不要加 /v1。",
        "cheapApi": True,
    },
    {
        "id": "zhipu",
        "label": "智谱 GLM",
        "kind": "openai",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "model": DEFAULT_ZHIPU_MODEL,
        "help": "在 open.bigmodel.cn 创建 Key。免费闪模型可填 glm-4-flash 或 glm-4.7-flash。地址填 https://open.bigmodel.cn/api/paas/v4。",
        "cheapApi": False,
    },
    {
        "id": "modelscope",
        "label": "魔搭 ModelScope",
        "kind": "openai",
        "baseUrl": "https://api-inference.modelscope.cn/v1",
        "model": DEFAULT_MODELSCOPE_MODEL,
        "help": "在 modelscope.cn 创建 Access Token。地址填 https://api-inference.modelscope.cn/v1，模型填平台上的模型 ID。",
        "cheapApi": False,
    },
    {
        "id": "custom",
        "label": "自定义 OpenAI 兼容",
        "kind": "openai",
        "baseUrl": "https://api.example.com/v1",
        "model": "your-model-name",
        "help": "任何兼容 POST /chat/completions 的网关都可以。地址填到 /v1 这一层，模型名按供应商文档填写，密钥只保存在本机。",
        "cheapApi": True,
    },
]


@dataclass
class Provider:
    name: str
    kind: str
    base_url: str
    model: str
    api_key: str = ""
    secret_id: str = ""
    secret_key: str = ""
    region: str = ""
    may_charge: bool = False
    billing_class: str = "free"
    cheap_api: bool = False
    enabled: bool = True

    @property
    def configured(self) -> bool:
        if not self.enabled:
            return False
        if self.kind == "tencent":
            return bool(self.secret_id and self.secret_key)
        return bool(self.api_key)


def load_overrides() -> dict[str, Any]:
    empty = {"order": [], "providers": {}, "routes": {}}
    if not OVERRIDES_PATH.exists():
        return empty
    try:
        payload = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(payload, dict):
        return empty
    providers = payload.get("providers") or {}
    order = payload.get("order") or []
    routes = payload.get("routes") or {}
    if not isinstance(providers, dict):
        providers = {}
    if not isinstance(order, list):
        order = []
    if not isinstance(routes, dict):
        routes = {}
    return {
        "order": [str(item).strip().lower() for item in order if str(item).strip()],
        "providers": providers,
        "routes": {
            str(task): [str(item).strip().lower() for item in items if str(item).strip()]
            for task, items in routes.items()
            if task in TASK_ROUTE_IDS and isinstance(items, list)
        },
    }


def task_provider_order(task: str, settings: Settings, overrides: dict[str, Any] | None = None) -> list[str]:
    if task not in TASK_ROUTE_IDS:
        raise ValueError(f"未知模型任务：{task}")
    stored = overrides if overrides is not None else load_overrides()
    routes = stored.get("routes") or {}
    if task in routes:
        return list(routes[task])
    if task == "translation":
        return list(stored.get("order") or settings.provider_order)
    return list(settings.editorial_order)


def provider_definitions(settings: Settings, overrides: dict[str, Any] | None = None) -> dict[str, Provider]:
    free_models = {
        "zhipu": {DEFAULT_ZHIPU_MODEL.lower(), "glm-4-flash"},
        "modelscope": {DEFAULT_MODELSCOPE_MODEL.lower()},
        "siliconflow": {"qwen/qwen2.5-7b-instruct"},
    }
    definitions = {
        "modelscope": Provider(
            "modelscope", "openai", "https://api-inference.modelscope.cn/v1",
            settings.modelscope_model, api_key=settings.modelscope_access_token,
            may_charge=settings.modelscope_model.lower() not in free_models["modelscope"],
            billing_class="free_shared_no_sla" if settings.modelscope_model.lower() in free_models["modelscope"] else "unverified_model",
        ),
        "zhipu": Provider(
            "zhipu", "openai", "https://open.bigmodel.cn/api/paas/v4",
            settings.zhipu_model, api_key=settings.zhipu_api_key,
            may_charge=settings.zhipu_model.lower() not in free_models["zhipu"],
            billing_class="free_model" if settings.zhipu_model.lower() in free_models["zhipu"] else "unverified_model",
        ),
        "siliconflow": Provider(
            "siliconflow", "openai", "https://api.siliconflow.cn/v1",
            settings.siliconflow_model, api_key=settings.siliconflow_api_key,
            may_charge=settings.siliconflow_model.lower() not in free_models["siliconflow"],
            billing_class="free_shared_rate_limited" if settings.siliconflow_model.lower() in free_models["siliconflow"] else "unverified_model",
        ),
        "tencent": Provider(
            "tencent", "tencent", "https://tmt.tencentcloudapi.com", "TextTranslate",
            secret_id=settings.tencent_secret_id, secret_key=settings.tencent_secret_key,
            region=settings.tencent_region, may_charge=not settings.tencent_free_quota_guarded,
            billing_class="free_monthly_guarded" if settings.tencent_free_quota_guarded else "paid_or_unverified_quota",
        ),
        "dashscope": Provider(
            "dashscope", "dashscope-mt", "https://dashscope.aliyuncs.com/compatible-mode/v1",
            settings.dashscope_model, api_key=settings.dashscope_api_key,
            may_charge=True, billing_class="time_limited_then_paid",
        ),
        "deepseek": Provider(
            "deepseek", "openai", "https://api.deepseek.com", settings.deepseek_model,
            api_key=settings.deepseek_api_key, may_charge=True, cheap_api=True,
            billing_class="cheap_api",
        ),
    }
    stored = overrides if overrides is not None else load_overrides()
    for provider_id, item in (stored.get("providers") or {}).items():
        if not isinstance(item, dict):
            continue
        api_key = str(item.get("apiKey") or "").strip()
        model = str(item.get("model") or "").strip()
        base_url = str(item.get("baseUrl") or "").rstrip("/")
        if provider_id in definitions:
            if api_key:
                definitions[provider_id].api_key = api_key
            if model:
                definitions[provider_id].model = model
            if provider_id in free_models and definitions[provider_id].model.lower() not in free_models[provider_id]:
                definitions[provider_id].may_charge = True
                definitions[provider_id].billing_class = "unverified_model"
            if base_url:
                definitions[provider_id].base_url = base_url
            official_endpoints = {
                "zhipu": "https://open.bigmodel.cn/api/paas/v4",
                "modelscope": "https://api-inference.modelscope.cn/v1",
                "siliconflow": "https://api.siliconflow.cn/v1",
            }
            if provider_id in official_endpoints and definitions[provider_id].base_url != official_endpoints[provider_id]:
                definitions[provider_id].may_charge = True
                definitions[provider_id].billing_class = "unverified_endpoint"
        elif item.get("enabled", True) and api_key and model and base_url:
            definitions[provider_id] = Provider(
                provider_id, str(item.get("kind") or "openai"), base_url, model,
                api_key=api_key, may_charge=True,
                cheap_api=bool(item.get("cheapApi", True)), billing_class="user_added",
            )
        if item.get("enabled") is False and provider_id in definitions:
            definitions[provider_id].enabled = False
    return definitions


def save_overrides(payload: dict[str, Any]) -> dict[str, Any]:
    OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    current = load_overrides()
    incoming = payload.get("providers") or {}
    merged: dict[str, Any] = dict(current.get("providers") or {})
    records = incoming if isinstance(incoming, list) else [{"id": key, **value} for key, value in incoming.items()]
    incoming_ids = [str(record.get("id") or "").strip().lower() for record in records]
    non_empty_ids = [provider_id for provider_id in incoming_ids if provider_id]
    if len(non_empty_ids) != len(set(non_empty_ids)):
        raise ValueError("提供方 ID 重复")
    for record, provider_id in zip(records, incoming_ids):
        if not provider_id:
            continue
        previous = merged.get(provider_id) or {}
        api_key = str(record.get("apiKey") or "").strip()
        merged[provider_id] = {
            "label": str(record.get("label") or previous.get("label") or provider_id),
            "kind": str(record.get("kind") or previous.get("kind") or "openai"),
            "baseUrl": str(record.get("baseUrl") or previous.get("baseUrl") or "").rstrip("/"),
            "model": str(record.get("model") or previous.get("model") or ""),
            "apiKey": api_key or previous.get("apiKey") or "",
            "enabled": bool(record.get("enabled", previous.get("enabled", True))),
            "cheapApi": bool(record.get("cheapApi", previous.get("cheapApi", True))),
        }
        if record.get("clearKey"):
            merged[provider_id]["apiKey"] = ""

    known_ids = set(merged) | {"deepseek", "zhipu", "modelscope", "siliconflow", "tencent", "dashscope"}
    routes = dict(current.get("routes") or {})
    incoming_routes = payload.get("routes") or {}
    if not isinstance(incoming_routes, dict):
        raise ValueError("模型任务路由格式无效")
    for task, items in incoming_routes.items():
        if task not in TASK_ROUTE_IDS or not isinstance(items, list):
            raise ValueError("模型任务路由无效")
        normalized = [str(item).strip().lower() for item in items if str(item).strip()]
        if len(normalized) != len(set(normalized)):
            raise ValueError(f"任务 {task} 的提供方顺序重复")
        unknown = set(normalized) - known_ids
        if unknown:
            raise ValueError(f"任务 {task} 包含未知提供方：{', '.join(sorted(unknown))}")
        routes[task] = normalized

    order = payload.get("order")
    if "translation" in incoming_routes:
        order = routes["translation"]
    elif isinstance(order, list):
        order = [str(item).strip().lower() for item in order if str(item).strip()]
        if len(order) != len(set(order)):
            raise ValueError("翻译提供方顺序重复")
        if set(order) - known_ids:
            raise ValueError("翻译路由包含未知提供方")
        routes["translation"] = order
    else:
        order = current.get("order") or [key for key, item in merged.items() if item.get("enabled") and item.get("apiKey")]
        routes["translation"] = order
    stored = {"order": order, "providers": merged, "routes": routes}
    OVERRIDES_PATH.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    return stored


def mask_key(value: str) -> str:
    key = (value or "").strip()
    if not key:
        return ""
    if len(key) <= 8:
        return "••••"
    return f"{key[:3]}••••{key[-4:]}"


def public_config(settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    stored = load_overrides()
    providers = []
    for preset in PROVIDER_PRESETS:
        override = (stored.get("providers") or {}).get(preset["id"], {})
        providers.append({
            **preset,
            "baseUrl": override.get("baseUrl") or preset["baseUrl"],
            "model": override.get("model") or preset["model"],
            "enabled": bool(override.get("enabled", preset["id"] == "deepseek")),
            "hasKey": bool(override.get("apiKey")),
            "maskedKey": mask_key(override.get("apiKey") or ""),
        })
    preset_ids = {item["id"] for item in PROVIDER_PRESETS}
    for provider_id, override in (stored.get("providers") or {}).items():
        if provider_id in preset_ids:
            continue
        providers.append({
            "id": provider_id,
            "label": override.get("label") or provider_id,
            "kind": override.get("kind") or "openai",
            "baseUrl": override.get("baseUrl") or "",
            "model": override.get("model") or "",
            "help": "自定义 OpenAI 兼容接口。密钥只保存在本机 data/provider_overrides.json。",
            "cheapApi": bool(override.get("cheapApi", True)),
            "enabled": bool(override.get("enabled", True)),
            "hasKey": bool(override.get("apiKey")),
            "maskedKey": mask_key(override.get("apiKey") or ""),
        })
    routes = {task: task_provider_order(task, settings, stored) for task in TASK_ROUTE_IDS}
    return {
        "presets": PROVIDER_PRESETS,
        "order": routes["translation"],
        "routes": routes,
        "providers": providers,
    }
