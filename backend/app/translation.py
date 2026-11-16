import asyncio
import hashlib
import hmac
import json
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

import httpx

from .model_center import BudgetExceeded, ModelCenterStore, openai_usage
from .provider_config import Provider, load_overrides, provider_definitions, task_provider_order
from .settings import Settings


PROMPT_VERSION = "word-referent-v6"
BARE_PRONOUN_GLOSSES = {"它", "它们", "这些", "那些", "这个", "那个", "他", "她", "其"}
FUNCTION_WORDS = {
    "it", "its", "itself", "they", "them", "their", "theirs", "this", "that", "these", "those",
    "he", "him", "his", "she", "her", "hers", "one", "ones", "which", "who", "whom",
    "the", "a", "an", "of", "to", "and", "or",
}
INVALID_TRANSLATIONS = {"", "语境释义", "这句话的中文语境翻译会显示在这里。"}
PROVIDER_QUALITY_PRIOR = {
    "zhipu": 0.95,
    "deepseek": 0.94,
    "modelscope": 0.88,
    "siliconflow": 0.76,
    "tencent": 0.84,
    "dashscope": 0.88,
}
PROVIDER_LATENCY_PRIOR_MS = {
    "zhipu": 900,
    "deepseek": 1100,
    "modelscope": 1200,
    "siliconflow": 1900,
    "tencent": 420,
    "dashscope": 650,
}
PROVIDER_SUCCESS_PRIOR = {
    "zhipu": 0.7,
    "deepseek": 0.88,
    "modelscope": 0.85,
    "siliconflow": 0.65,
    "tencent": 0.95,
    "dashscope": 0.9,
}

LOCAL_DICTIONARY = {
    "seeking": {
        "lemma": "seek",
        "phonetic": "/siːk/",
        "partOfSpeech": "v.",
        "translation": "寻求",
        "commonTranslation": "寻找",
    },
    "curiosity": {
        "lemma": "curiosity",
        "phonetic": "/ˌkjʊəriˈɒsəti/",
        "partOfSpeech": "n.",
        "translation": "好奇心",
        "commonTranslation": "好奇心",
    },
    "infrastructure": {
        "lemma": "infrastructure",
        "phonetic": "/ˈɪnfrəstrʌktʃə/",
        "partOfSpeech": "n.",
        "translation": "基础结构",
        "commonTranslation": "基础设施",
    },
    "vibrant": {
        "lemma": "vibrant",
        "phonetic": "/ˈvaɪbrənt/",
        "partOfSpeech": "adj.",
        "translation": "充满活力的",
        "commonTranslation": "鲜艳的",
    },
    "thoughtful": {
        "lemma": "thoughtful",
        "phonetic": "/ˈθɔːtfl/",
        "partOfSpeech": "adj.",
        "translation": "善于思考的",
        "commonTranslation": "体贴的",
    },
    "library": {
        "lemma": "library",
        "phonetic": "/ˈlaɪbreri/",
        "partOfSpeech": "n.",
        "translation": "图书馆",
        "commonTranslation": "图书馆",
    },
    "avoid": {
        "lemma": "avoid",
        "phonetic": "/əˈvɔɪd/",
        "partOfSpeech": "v.",
        "translation": "避免",
        "commonTranslation": "避免",
    },
    "reveal": {
        "lemma": "reveal",
        "phonetic": "/rɪˈviːl/",
        "partOfSpeech": "v.",
        "translation": "透露",
        "commonTranslation": "揭示",
    },
    "responsibility": {
        "lemma": "responsibility",
        "phonetic": "/rɪˌspɒnsəˈbɪləti/",
        "partOfSpeech": "n.",
        "translation": "责任",
        "commonTranslation": "责任",
    },
    "pollinators": {
        "lemma": "pollinator",
        "phonetic": "/ˈpɒlɪneɪtəz/",
        "partOfSpeech": "n.",
        "translation": "传粉者",
        "commonTranslation": "传粉者",
    },
    "accuracy": {
        "lemma": "accuracy",
        "phonetic": "/ˈækjʊrəsi/",
        "partOfSpeech": "n.",
        "translation": "准确性",
        "commonTranslation": "准确性",
    },
}

KNOWN_SENTENCES = {
    "Independent bookstores are more than places to buy books.": "独立书店不只是买书的地方。",
    "They are public squares in miniature—where ideas meet, neighbors bump into one another, and curiosity feels at home.": "它们像一座座微型公共广场：思想在这里相遇，邻里不期而遇，好奇心也能自在生长。",
    "Walk into one on a rainy afternoon and you might hear a teenager recommending a novel to a stranger, or a poet testing a new line at an open mic.": "在一个下雨的午后走进店里，你也许会听见一位少年向陌生人推荐小说，或是一位诗人在开放麦上试读新写的诗句。",
    "These moments do not trend online, but they build the quiet infrastructure of a thoughtful community.": "这些瞬间不会成为网络热点，却在悄然筑起一个善于思考的社区所需要的基础。",
    "After years of online shopping and short videos, readers are seeking something real: places where they can slow down, think deeply, and connect with others.": "经历多年的网络购物和短视频浪潮后，读者开始寻找真实的空间，在那里放慢脚步、深入思考并与他人建立联系。",
    "Independent bookstores and community reading spaces are filling that need.": "独立书店与社区阅读空间正在回应这种需要。",
    "In many cities, these spaces do more than sell books.": "在许多城市，这些空间所做的远不只是卖书。",
    "They host author talks, reading clubs, and workshops for children.": "它们会举办作者分享会、读书会和儿童工作坊。",
    "They invite neighbors to share ideas and stories.": "它们邀请邻里分享想法与故事。",
    "In a fast-changing world, that sense of community matters more than ever.": "在迅速变化的世界里，这种社区归属感比以往任何时候都更重要。",
    "Independent bookstores are becoming places where people meet, read, and grow together.": "独立书店正重新成为人们相遇、阅读并共同成长的空间。",
    "The more we support these spaces, the more vibrant and wise our communities will be.": "我们越支持这些空间，社区就会越有活力，也越富有智慧。",
}


class TranslationUnavailable(RuntimeError):
    """Raised only after every configured provider and honest local fallback fail."""


class ProviderResponseError(RuntimeError):
    pass


class TranslationGateway:
    def __init__(self, settings: Settings, store: ModelCenterStore | None = None):
        self.settings = settings
        self.store = store or ModelCenterStore()
        self.cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
        self.inflight: dict[str, asyncio.Task] = {}
        self.failure_cache: dict[str, float] = {}
        self.cooldown_until: dict[str, float] = {}
        self.cache_metrics = {
            "memoryHits": 0,
            "diskHits": 0,
            "misses": 0,
            "coalesced": 0,
            "writes": 0,
            "negativeHits": 0,
        }
        self._http = httpx.AsyncClient(
            timeout=None,
            limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
        )
        overrides = load_overrides()
        definitions = provider_definitions(settings, overrides)
        requested_names = task_provider_order("translation", settings, overrides)
        requested = [definitions[name] for name in requested_names if name in definitions]
        self.providers = [
            provider
            for provider in requested
            if self._route_allowed(provider)
        ]
        self._all_providers = definitions
        self._provider_position = {provider.name: index for index, provider in enumerate(requested)}
        self.metrics: dict[str, dict[str, Any]] = {}
        enabled = {provider.name for provider in self.providers}
        for provider in definitions.values():
            self.metrics[provider.name] = {
                "provider": provider.name,
                "model": provider.model,
                "enabled": provider.name in enabled,
                "configured": provider.configured,
                "billingClass": provider.billing_class,
                "mayCharge": provider.may_charge,
                "status": (
                    "ready"
                    if provider.configured and provider.name in enabled
                    else "blocked_by_zero_budget"
                    if (
                        provider.configured
                        and provider.name in self._provider_position
                        and provider.may_charge
                    )
                    else "not_configured"
                ),
                "attempts": 0,
                "successes": 0,
                "failures": 0,
                "rateLimited": 0,
                "timeouts": 0,
                "lastLatencyMs": None,
                "averageLatencyMs": None,
                "lastError": None,
            }

    def _key(self, scope: str, payload: dict) -> str:
        normalized = {
            "word": str(payload.get("word") or "").strip().lower(),
            "sentence": re.sub(r"\s+", " ", str(payload.get("sentence") or "")).strip(),
            "before": re.sub(r"\s+", " ", str(payload.get("before") or "")).strip(),
            "after": re.sub(r"\s+", " ", str(payload.get("after") or "")).strip(),
            "targetLanguage": payload.get("targetLanguage", "zh-CN"),
            "contentHash": payload.get("contentHash", ""),
        }
        if scope != "word":
            normalized.pop("word", None)
        encoded = json.dumps(
            {
                "scope": scope,
                "promptVersion": PROMPT_VERSION,
                **normalized,
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode()
        return hashlib.sha256(encoded).hexdigest()

    def _provider_score(self, provider: Provider) -> float:
        metric = self.metrics[provider.name]
        attempts = metric["attempts"]
        success_rate = (
            metric["successes"] + PROVIDER_SUCCESS_PRIOR.get(provider.name, 0.8) * 3
        ) / (attempts + 3)
        latency = metric["averageLatencyMs"] or PROVIDER_LATENCY_PRIOR_MS.get(provider.name, 1200)
        speed_score = max(
            0.0,
            1 - latency / max(1, self.settings.translation_provider_timeout_ms * 1.5),
        )
        order_penalty = self._provider_position.get(provider.name, 99) * 0.004
        return round(
            PROVIDER_QUALITY_PRIOR.get(provider.name, 0.86) * 0.5
            + success_rate * 0.3
            + speed_score * 0.2
            - order_penalty,
            4,
        )

    def _ranked_providers(self) -> list[Provider]:
        available = list(self.providers)
        if not self.settings.translation_dynamic_routing:
            return available
        return sorted(available, key=self._provider_score, reverse=True)

    def _route_allowed(self, provider: Provider | None = None) -> bool:
        if provider is None:
            return False
        if not provider.may_charge:
            return True
        return (
            self.settings.paid_provider_enabled
            and self.settings.daily_paid_budget_cny > 0
            and self.settings.paid_request_max_cny > 0
        )

    def _provider_timeout_ms(self, provider: Provider, scope: str = "word") -> int:
        base = max(200, self.settings.translation_provider_timeout_ms)
        if scope == "word":
            if provider.name == "zhipu":
                return min(base, 2200)
            if provider.name == "deepseek":
                return min(base, 4200)
            return min(base, 3500)
        if provider.name == "zhipu":
            return min(base, 2800)
        if provider.name == "deepseek":
            return min(base + 4000, 12000)
        return min(base, 5000)

    def _trim_payload(self, payload: dict) -> dict:
        trimmed = dict(payload)
        trimmed["word"] = str(payload.get("word") or "")[:80]
        trimmed["sentence"] = re.sub(r"\s+", " ", str(payload.get("sentence") or "")).strip()[:500]
        trimmed["before"] = re.sub(r"\s+", " ", str(payload.get("before") or "")).strip()[:240]
        trimmed["after"] = re.sub(r"\s+", " ", str(payload.get("after") or "")).strip()[:240]
        return trimmed

    def provider_status(self) -> list[dict]:
        ranks = {
            provider.name: index + 1
            for index, provider in enumerate(self._ranked_providers())
        }
        result = []
        for name, provider in self._all_providers.items():
            metric = dict(self.metrics[name])
            attempts = metric["attempts"]
            metric["successRate"] = round(metric["successes"] / attempts, 4) if attempts else None
            metric["routeScore"] = self._provider_score(provider)
            metric["routeRank"] = ranks.get(name)
            result.append(metric)
        return result

    def overview(self) -> dict:
        return {
            "promptVersion": PROMPT_VERSION,
            "tasks": self.store.usage_summary(),
            "dynamicRouting": self.settings.translation_dynamic_routing,
            "cache": {
                **self.cache_metrics,
                "memoryEntries": len(self.cache),
                "diskEntries": self.store.cache_entries(),
                "ttlSeconds": self.settings.translation_cache_ttl_seconds,
            },
            "costGuard": {
                "paidProvidersEnabled": self.settings.paid_provider_enabled,
                "fallbackMode": self.settings.paid_fallback_mode,
                "dailyBudgetCny": self.settings.daily_paid_budget_cny,
                "perRequestMaxCny": self.settings.paid_request_max_cny,
                "tencentFreeQuotaGuarded": self.settings.tencent_free_quota_guarded,
                "reservedTodayCny": self.store.reserved_today_cny(),
            },
        }

    def _memory_get(self, key: str) -> dict | None:
        cached = self.cache.get(key)
        if not cached:
            return None
        expires_at, value = cached
        if expires_at <= time.monotonic():
            self.cache.pop(key, None)
            return None
        self.cache.move_to_end(key)
        return value

    def _memory_set(self, key: str, value: dict) -> None:
        expires_at = time.monotonic() + self.settings.translation_cache_ttl_seconds
        self.cache[key] = (expires_at, value)
        self.cache.move_to_end(key)
        while len(self.cache) > self.settings.translation_memory_cache_entries:
            self.cache.popitem(last=False)

    async def _cache_get(self, key: str) -> dict | None:
        cached = self._memory_get(key)
        if cached:
            self.cache_metrics["memoryHits"] += 1
            return {**cached, "cached": True, "cacheLayer": "memory", "latencyMs": 0}
        cached = self.store.cache_get(key)
        if cached:
            self._memory_set(key, cached)
            self.cache_metrics["diskHits"] += 1
            return {**cached, "cached": True, "cacheLayer": "disk", "latencyMs": 0}
        self.cache_metrics["misses"] += 1
        return None

    async def _cache_set(self, key: str, value: dict) -> None:
        stored = {**value, "cached": False}
        stored.pop("cacheLayer", None)
        self._memory_set(key, stored)
        self.store.cache_set(key, stored, self.settings.translation_cache_ttl_seconds)
        self.cache_metrics["writes"] += 1

    def clear_cache(self) -> int:
        self.cache.clear()
        return self.store.cache_clear()

    async def translate(self, scope: str, payload: dict) -> dict:
        key = self._key(scope, payload)
        cached = await self._cache_get(key)
        if cached:
            return cached
        if self.failure_cache.get(key, 0) > time.monotonic():
            self.cache_metrics["negativeHits"] += 1
            raise TranslationUnavailable("翻译线路繁忙，请稍后重试")
        self.failure_cache.pop(key, None)

        existing = self.inflight.get(key)
        if existing:
            self.cache_metrics["coalesced"] += 1
            result = await asyncio.shield(existing)
            return {**result, "coalesced": True}
        task = asyncio.create_task(self._translate_shared(key, scope, payload))
        self.inflight[key] = task
        return await asyncio.shield(task)

    async def _translate_shared(self, key: str, scope: str, payload: dict) -> dict:
        try:
            result = await self._translate_uncached(scope, payload)
            if result.get("cacheLayer") != "local":
                await self._cache_set(key, result)
            return result
        except TranslationUnavailable:
            self.failure_cache[key] = time.monotonic() + self.settings.translation_failure_ttl_seconds
            raise
        finally:
            if self.inflight.get(key) is asyncio.current_task():
                self.inflight.pop(key, None)

    @staticmethod
    def _estimated_token_count(value: dict) -> int:
        return max(1, round(len(json.dumps(value, ensure_ascii=False)) / 4))

    async def _attempt_provider(self, provider: Provider, scope: str, payload: dict, timeout: float) -> dict:
        started = time.perf_counter()
        reservation = None
        try:
            if provider.may_charge:
                reservation = await self._reserve_paid_usage(provider, payload)
            result = await asyncio.wait_for(self._call_provider(provider, scope, payload), timeout=timeout)
            usage = result.pop("_usage", {})
            tokens_reported = bool(usage)
            input_tokens = usage.get("input_tokens", 0) if tokens_reported else self._estimated_token_count(payload)
            output_tokens = usage.get("output_tokens", 0) if tokens_reported else self._estimated_token_count(result)
            result = self._validate_result(scope, result, provider)
            provider_latency = round((time.perf_counter() - started) * 1000)
            metric = self.metrics[provider.name]
            previous_average = metric["averageLatencyMs"]
            average_latency = (
                provider_latency
                if previous_average is None
                else round(previous_average * 0.7 + provider_latency * 0.3)
            )
            metric.update(
                status="healthy",
                attempts=metric["attempts"] + 1,
                successes=metric["successes"] + 1,
                lastLatencyMs=provider_latency,
                averageLatencyMs=average_latency,
                lastError=None,
            )
            self.cooldown_until.pop(provider.name, None)
            await self.store.record_usage(
                "translation", provider.name, provider.model, True,
                input_tokens, output_tokens, tokens_reported,
                reservation.amount if reservation else 0,
                day=reservation.day if reservation else None,
            )
            return {
                **result,
                "provider": provider.name,
                "model": provider.model,
                "cached": False,
                "cacheLayer": "none",
                "providerLatencyMs": provider_latency,
                "billingClass": provider.billing_class,
            }
        except BaseException as error:
            await self._release_paid_usage(reservation)
            if isinstance(error, Exception):
                await self.store.record_usage(
                    "translation", provider.name, provider.model, False,
                    self._estimated_token_count(payload), 0, False, 0,
                    day=reservation.day if reservation else None,
                )
                self._record_failure(provider, error, round((time.perf_counter() - started) * 1000))
            raise

    def _available_providers(self, payload: dict) -> list[Provider]:
        available = []
        for provider in self._ranked_providers():
            if not provider.configured:
                continue
            if provider.may_charge and not self._paid_provider_allowed(payload):
                continue
            cooldown_until = self.cooldown_until.get(provider.name, 0)
            if cooldown_until > time.monotonic():
                self.metrics[provider.name]["status"] = "cooldown"
                continue
            self.cooldown_until.pop(provider.name, None)
            available.append(provider)
        return available

    async def _translate_uncached(self, scope: str, payload: dict) -> dict:
        payload = self._trim_payload(payload)
        started_total = time.perf_counter()
        deadline = started_total + self.settings.translation_total_timeout_ms / 1000
        providers = self._available_providers(payload)

        async def try_one(provider: Provider) -> dict:
            remaining = deadline - time.perf_counter()
            if remaining <= 0.05:
                raise TranslationUnavailable("timeout")
            timeout = min(self._provider_timeout_ms(provider, scope) / 1000, remaining)
            return await self._attempt_provider(provider, scope, payload, timeout)

        def finish(result: dict) -> dict:
            return {
                **result,
                "latencyMs": round((time.perf_counter() - started_total) * 1000),
            }

        if not providers:
            local = self._local(scope, payload)
            if local:
                return local
            raise TranslationUnavailable("当前翻译服务暂时不可用，请稍后重试")

        primary, *rest = providers
        pending: set[asyncio.Task] = {asyncio.create_task(try_one(primary))}
        backup_started = False
        hedge_s = 0.2 if scope == "word" else 0.4

        while pending:
            timeout = None if backup_started or not rest else hedge_s
            done, pending = await asyncio.wait(
                pending,
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done and rest and not backup_started:
                pending.add(asyncio.create_task(try_one(rest[0])))
                backup_started = True
                rest = rest[1:]
                continue
            for task in done:
                try:
                    result = finish(task.result())
                    for other in pending:
                        other.cancel()
                    if pending:
                        await asyncio.gather(*pending, return_exceptions=True)
                    return result
                except Exception:
                    continue
            if not pending:
                break

        for provider in rest:
            remaining = deadline - time.perf_counter()
            if remaining <= 0.05:
                break
            try:
                return finish(await try_one(provider))
            except Exception:
                continue

        local = self._local(scope, payload)
        if local:
            return local
        raise TranslationUnavailable("当前翻译服务暂时不可用，请稍后重试")

    def _paid_provider_allowed(self, payload: dict) -> bool:
        if (
            not self.settings.paid_provider_enabled
            or self.settings.daily_paid_budget_cny <= 0
            or self.settings.paid_request_max_cny <= 0
        ):
            return False
        mode = self.settings.paid_fallback_mode.strip().lower()
        requested = str(payload.get("qualityMode", "free")).lower()
        return (
            mode == "automatic" and requested in {"free", "balanced", "precise"}
        ) or (mode == "manual" and requested == "precise")

    @staticmethod
    def _estimated_paid_cost(provider: Provider, payload: dict) -> float:
        characters = sum(
            len(str(payload.get(field) or ""))
            for field in ("word", "sentence", "before", "after")
        )
        if provider.name == "tencent":
            return max(0.0001, characters * 58 / 1_000_000)
        estimated_tokens = max(1, characters / 4) + (96 if payload.get("word") else 320)
        conservative_cny_per_million = {
            "dashscope": 2.0,
            "deepseek": 8.0,
            "siliconflow": 8.0,
        }.get(provider.name, 10.0)
        return max(0.0001, estimated_tokens * conservative_cny_per_million / 1_000_000)

    async def _reserve_paid_usage(self, provider: Provider, payload: dict):
        estimate = self._estimated_paid_cost(provider, payload)
        try:
            return await self.store.reserve(
                "translation", provider.name, estimate,
                self.settings.daily_paid_budget_cny,
                self.settings.paid_request_max_cny,
            )
        except BudgetExceeded as error:
            raise TranslationUnavailable(str(error)) from error

    async def _release_paid_usage(self, reservation) -> None:
        if reservation:
            await self.store.release(reservation)

    def _record_failure(self, provider: Provider, error: Exception, latency_ms: int = 0) -> None:
        metric = self.metrics[provider.name]
        metric["status"] = "degraded"
        metric["attempts"] += 1
        metric["failures"] += 1
        metric["lastLatencyMs"] = latency_ms
        metric["lastError"] = type(error).__name__
        if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
            metric["timeouts"] += 1
            metric["status"] = "cooldown"
            self.cooldown_until[provider.name] = time.monotonic() + 8
        if isinstance(error, httpx.HTTPStatusError):
            status = error.response.status_code
            metric["lastError"] = f"HTTP_{status}"
            if status == 429:
                metric["rateLimited"] += 1
                retry_after = error.response.headers.get("Retry-After", "")
                try:
                    cooldown = max(5, min(300, int(float(retry_after))))
                except (TypeError, ValueError):
                    cooldown = 30
                metric["status"] = "cooldown"
                self.cooldown_until[provider.name] = time.monotonic() + cooldown
            elif status >= 500:
                metric["status"] = "cooldown"
                self.cooldown_until[provider.name] = time.monotonic() + 15

    async def _call_provider(self, provider: Provider, scope: str, payload: dict) -> dict:
        if provider.kind == "tencent":
            return await self._call_tencent(provider, scope, payload)
        if provider.kind == "dashscope-mt":
            return await self._call_dashscope_mt(provider, scope, payload)
        return await self._call_openai_compatible(provider, scope, payload)

    async def _call_openai_compatible(self, provider: Provider, scope: str, payload: dict) -> dict:
        if scope == "word":
            instruction = (
                "You are an English-to-Simplified-Chinese reading assistant. "
                "Use the current sentence and the adjacent sentences. Translate only the selection. "
                "Return one strict JSON object with lemma, phonetic, partOfSpeech, translation, commonTranslation, referent. "
                "If the selection is a pronoun or demonstrative "
                "(it, its, itself, they, them, their, this, that, these, those, he, him, his, she, her, one, ones, which, who, whom), "
                "set referent=true, leave commonTranslation empty, and put the antecedent in translation as "
                "Simplified Chinese like 指代脉冲星 or 指代前文的恒星风. Never gloss these as 它/它们/这些/那些/这个/那个. "
                "For other tiny function words (the, a, an, of, to, and, or), also set referent=true, "
                "describe only their role in THIS sentence, and leave commonTranslation empty. "
                "For content words: referent=false; translation is the contextual sense in 1-12 characters; "
                "commonTranslation is the usual dictionary sense only when it clearly differs, otherwise empty. "
                "Use empty strings when lemma, phonetic, or partOfSpeech cannot be verified. No markdown."
            )
        else:
            instruction = (
                "Translate ONLY the current English sentence into natural, accurate Simplified Chinese. "
                "Adjacent sentences are context only: use them to resolve pronouns, references, tense, tone, and word sense. "
                "Do not translate the adjacent sentences, do not summarize, and do not add facts that are not in the current sentence. "
                "Prefer contextual meaning over word-for-word calque. Preserve names and factual meaning. "
                "Return one strict JSON object with translation. No markdown."
            )
        body: dict[str, Any] = {
            "model": provider.model,
            "temperature": 0,
            "max_tokens": 220 if scope == "word" else 400,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": instruction},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        }
        if provider.name in {"zhipu", "deepseek"}:
            body["thinking"] = {"type": "disabled"}
        if provider.name == "modelscope":
            body["enable_thinking"] = False
        headers = {"Authorization": f"Bearer {provider.api_key}"}
        response = await self._http.post(
            f"{provider.base_url.rstrip('/')}/chat/completions",
            headers=headers,
            json=body,
        )
        if response.status_code == 400:
            body.pop("response_format", None)
            body.pop("thinking", None)
            body.pop("enable_thinking", None)
            response = await self._http.post(
                f"{provider.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=body,
            )
        response.raise_for_status()
        response_payload = response.json()
        message = response_payload["choices"][0]["message"]
        content = message.get("content") or message.get("reasoning_content") or ""
        result = self._parse_json_content(content)
        usage = openai_usage(response_payload.get("usage"))
        if usage is not None:
            result["_usage"] = usage
        return result

    async def _call_dashscope_mt(self, provider: Provider, scope: str, payload: dict) -> dict:
        source_text = payload.get("word", "") if scope == "word" else payload["sentence"]
        async with httpx.AsyncClient(base_url=provider.base_url, timeout=None) as client:
            response = await client.post(
                "/chat/completions",
                headers={"Authorization": f"Bearer {provider.api_key}"},
                json={
                    "model": provider.model,
                    "messages": [{"role": "user", "content": source_text}],
                    "translation_options": {"source_lang": "English", "target_lang": "Chinese"},
                },
            )
            response.raise_for_status()
            translation = response.json()["choices"][0]["message"]["content"]
            return {"translation": translation, "quality": "basic"}

    async def _call_tencent(self, provider: Provider, scope: str, payload: dict) -> dict:
        source_text = payload.get("word", "") if scope == "word" else payload["sentence"]
        body = json.dumps(
            {"SourceText": source_text, "Source": "en", "Target": "zh", "ProjectId": 0},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        timestamp = int(time.time())
        date = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")
        service = "tmt"
        host = "tmt.tencentcloudapi.com"
        algorithm = "TC3-HMAC-SHA256"
        canonical_headers = f"content-type:application/json; charset=utf-8\nhost:{host}\n"
        signed_headers = "content-type;host"
        hashed_payload = hashlib.sha256(body.encode("utf-8")).hexdigest()
        canonical_request = f"POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}"
        credential_scope = f"{date}/{service}/tc3_request"
        hashed_request = hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
        string_to_sign = f"{algorithm}\n{timestamp}\n{credential_scope}\n{hashed_request}"

        def sign(key: bytes, message: str) -> bytes:
            return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()

        secret_date = sign(("TC3" + provider.secret_key).encode("utf-8"), date)
        secret_service = sign(secret_date, service)
        secret_signing = sign(secret_service, "tc3_request")
        signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        authorization = (
            f"{algorithm} Credential={provider.secret_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        headers = {
            "Authorization": authorization,
            "Content-Type": "application/json; charset=utf-8",
            "Host": host,
            "X-TC-Action": "TextTranslate",
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Version": "2018-03-21",
            "X-TC-Region": provider.region,
        }
        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.post(provider.base_url, headers=headers, content=body.encode("utf-8"))
            response.raise_for_status()
            result = response.json().get("Response", {})
            if result.get("Error"):
                raise ProviderResponseError(result["Error"].get("Code", "TencentTranslationError"))
            return {"translation": result.get("TargetText", ""), "quality": "basic"}

    @staticmethod
    def _parse_json_content(content: str) -> dict:
        text = content.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ProviderResponseError("Provider did not return JSON")
        return json.loads(text[start : end + 1])

    @staticmethod
    def _validate_result(scope: str, result: dict, provider: Provider) -> dict:
        translation = result.get("translation")
        if not isinstance(translation, str):
            raise ProviderResponseError("Missing translation")
        translation = translation.strip()
        if translation in INVALID_TRANSLATIONS or not re.search(r"[\u3400-\u9fff]", translation):
            raise ProviderResponseError("Translation is empty or not Simplified Chinese")
        if scope == "word" and translation in BARE_PRONOUN_GLOSSES:
            raise ProviderResponseError("Bare pronoun gloss")
        if scope == "word" and len(translation) > 56:
            raise ProviderResponseError("Word gloss is too long")
        quality = result.get("quality") or ("contextual" if provider.kind == "openai" else "basic")
        if quality not in {"contextual", "basic"}:
            quality = "contextual" if provider.kind == "openai" else "basic"
        response = {"scope": scope, "quality": quality, "translation": translation}
        if scope == "word":
            for field in ("lemma", "phonetic", "partOfSpeech"):
                value = result.get(field, "")
                response[field] = value.strip() if isinstance(value, str) else ""
            common = result.get("commonTranslation", "")
            common = common.strip() if isinstance(common, str) else ""
            referent = bool(result.get("referent")) or bool(re.match(r"^(?:文中)?指代", translation))
            if referent or common in INVALID_TRANSLATIONS:
                common = ""
            elif not re.search(r"[\u3400-\u9fff]", common):
                common = ""
            if len(common) > 40:
                common = ""
            if common == translation:
                common = ""
            response["commonTranslation"] = common
            response["referent"] = referent
        return response

    @staticmethod
    def _local(scope: str, payload: dict) -> dict | None:
        if scope == "word":
            word = payload.get("word", "").lower().strip(".,;:!?\"'()[]")
            if word in FUNCTION_WORDS:
                return None
            entry = LOCAL_DICTIONARY.get(word)
            if not entry:
                return None
            return {
                "scope": "word",
                "quality": "basic",
                **entry,
                "provider": "local-corpus",
                "model": "dictionary",
                "cached": False,
                "cacheLayer": "local",
                "latencyMs": 1,
                "providerLatencyMs": 1,
                "billingClass": "local",
            }
        translation = KNOWN_SENTENCES.get(payload["sentence"])
        if not translation:
            return None
        return {
            "scope": "sentence",
            "quality": "basic",
            "translation": translation,
            "provider": "local-corpus",
            "model": "demo-corpus",
            "cached": False,
            "cacheLayer": "local",
            "latencyMs": 1,
            "providerLatencyMs": 1,
            "billingClass": "local",
        }
