from __future__ import annotations

import json
from pathlib import Path
from typing import Any


OVERRIDES_PATH = Path(__file__).resolve().parent.parent / "data" / "provider_overrides.json"

PROVIDER_PRESETS = [
    {
        "id": "deepseek",
        "label": "DeepSeek",
        "kind": "openai",
        "baseUrl": "https://api.deepseek.com",
        "model": "deepseek-chat",
        "help": "在 platform.deepseek.com 创建 API Key。推荐模型 deepseek-chat，不要用 reasoner。接口地址填 https://api.deepseek.com，不要加 /v1。",
        "cheapApi": True,
    },
    {
        "id": "zhipu",
        "label": "智谱 GLM",
        "kind": "openai",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-4-flash",
        "help": "在 open.bigmodel.cn 创建 Key。免费闪模型可填 glm-4-flash 或 glm-4.7-flash。地址填 https://open.bigmodel.cn/api/paas/v4。",
        "cheapApi": False,
    },
    {
        "id": "modelscope",
        "label": "魔搭 ModelScope",
        "kind": "openai",
        "baseUrl": "https://api-inference.modelscope.cn/v1",
        "model": "Qwen/Qwen2.5-7B-Instruct",
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


def load_overrides() -> dict[str, Any]:
    if not OVERRIDES_PATH.exists():
        return {"order": [], "providers": {}}
    try:
        payload = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"order": [], "providers": {}}
    if not isinstance(payload, dict):
        return {"order": [], "providers": {}}
    providers = payload.get("providers") or {}
    order = payload.get("order") or []
    if not isinstance(providers, dict):
        providers = {}
    if not isinstance(order, list):
        order = []
    return {
        "order": [str(item).strip() for item in order if str(item).strip()],
        "providers": providers,
    }


def save_overrides(payload: dict[str, Any]) -> dict[str, Any]:
    OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    current = load_overrides()
    incoming = payload.get("providers") or {}
    merged: dict[str, Any] = dict(current.get("providers") or {})
    if isinstance(incoming, list):
        records = incoming
    else:
        records = [{"id": key, **value} for key, value in incoming.items()]
    for record in records:
        provider_id = str(record.get("id") or "").strip().lower()
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
    order = payload.get("order")
    if not isinstance(order, list) or not order:
        order = [key for key, item in merged.items() if item.get("enabled") and item.get("apiKey")]
    stored = {
        "order": [str(item).strip().lower() for item in order if str(item).strip()],
        "providers": merged,
    }
    OVERRIDES_PATH.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    return stored


def mask_key(value: str) -> str:
    key = (value or "").strip()
    if not key:
        return ""
    if len(key) <= 8:
        return "••••"
    return f"{key[:3]}••••{key[-4:]}"


def public_config() -> dict[str, Any]:
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
    extra_ids = [
        provider_id for provider_id in (stored.get("providers") or {})
        if provider_id not in {item["id"] for item in PROVIDER_PRESETS}
    ]
    for provider_id in extra_ids:
        override = stored["providers"][provider_id]
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
    return {
        "presets": PROVIDER_PRESETS,
        "order": stored.get("order") or ["deepseek"],
        "providers": providers,
    }
