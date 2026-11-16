from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import httpx

from .model_center import BudgetExceeded, ModelCenterStore, openai_usage
from .provider_config import Provider, load_overrides, provider_definitions, task_provider_order
from .settings import Settings


EditorialProvider = Provider


LEVEL_TARGETS = {
    "A1": (160, 250, "Use very common everyday vocabulary, short simple sentences, and one concrete idea per sentence."),
    "A2": (250, 350, "Use common everyday vocabulary, short sentences, and one idea per sentence."),
    "B1": (350, 500, "Use clear standard English, moderate sentence length, and explain technical terms."),
    "B2": (500, 650, "Use varied sentence structures and precise academic vocabulary with sufficient context."),
    "C1": (650, 800, "Use nuanced, natural English and complex ideas while keeping the argument coherent."),
    "C2": (800, 1000, "Use sophisticated natural English, implicit meaning, subtle evaluation, and complex ideas without simplifying the argument."),
}

FORM_INSTRUCTIONS = {
    "story": "Form: story. Write an original narrative grounded only in the evidence; never invent factual claims.",
    "science": "Form: science. Explain the evidence as a clear, accurate science article with limitations and context.",
    "explainer": "Form: explainer. Write a clear general-interest explanation with a connected opening, body and conclusion.",
}


class EditorialUnavailable(RuntimeError):
    pass


class EditorialGateway:
    def __init__(self, settings: Settings, store: ModelCenterStore | None = None):
        self.settings = settings
        self.store = store or ModelCenterStore()
        overrides = load_overrides()
        definitions = provider_definitions(settings, overrides)
        requested_names = task_provider_order("daily_article", settings, overrides)
        self.providers = [
            definitions[name]
            for name in requested_names
            if name in definitions and definitions[name].kind == "openai" and self._route_allowed(definitions[name])
        ]
        self.cooldown_until: dict[str, float] = {}
        base_quality = {"zhipu": 0.96, "deepseek": 0.95, "modelscope": 0.88, "siliconflow": 0.65}
        self.metrics = {
            name: {
                "quality": base_quality.get(name, 0.75),
                "successes": 0,
                "failures": 0,
                "latencyMs": None,
            }
            for name in definitions
        }

    def _ranked_providers(self) -> list[EditorialProvider]:
        def score(provider: EditorialProvider) -> float:
            metric = self.metrics[provider.name]
            total = metric["successes"] + metric["failures"]
            success_rate = metric["successes"] / total if total else 0.8
            latency_score = (
                max(0.0, 1 - metric["latencyMs"] / self.settings.editorial_provider_timeout_ms)
                if metric["latencyMs"] is not None
                else 0.7
            )
            return metric["quality"] * 0.5 + success_rate * 0.3 + latency_score * 0.2

        return sorted(self.providers, key=score, reverse=True)

    def _route_allowed(self, provider: EditorialProvider) -> bool:
        if not provider.may_charge:
            return True
        return (
            self.settings.paid_provider_enabled
            and self.settings.daily_paid_budget_cny > 0
            and self.settings.paid_request_max_cny > 0
        )

    @staticmethod
    def _estimated_paid_cost(provider: EditorialProvider, body: dict) -> float:
        serialized = json.dumps(body, ensure_ascii=False)
        estimated_tokens = max(1, len(serialized) / 4) + int(body.get("max_tokens") or 0)
        cny_per_million = {"deepseek": 8.0, "siliconflow": 8.0}.get(provider.name, 10.0)
        return max(0.0001, estimated_tokens * cny_per_million / 1_000_000)

    async def _reserve_paid_usage(self, provider: EditorialProvider, body: dict):
        if not provider.may_charge:
            return None
        if not self._route_allowed(provider):
            raise EditorialUnavailable("付费内容模型未启用或预算未配置")
        try:
            return await self.store.reserve(
                "daily_article", provider.name, self._estimated_paid_cost(provider, body),
                self.settings.daily_paid_budget_cny,
                self.settings.paid_request_max_cny,
            )
        except BudgetExceeded as error:
            raise EditorialUnavailable(str(error)) from error

    async def _post(self, provider: EditorialProvider, body: dict) -> dict:
        reservation = await self._reserve_paid_usage(provider, body)
        request_body = dict(body)
        try:
            async with httpx.AsyncClient(base_url=provider.base_url, timeout=None) as client:
                response = await client.post(
                    "/chat/completions",
                    headers={"Authorization": f"Bearer {provider.api_key}"},
                    json=body,
                )
                if response.status_code == 400:
                    retry_body = dict(body)
                    retry_body.pop("response_format", None)
                    retry_body.pop("thinking", None)
                    retry_body.pop("enable_thinking", None)
                    response = await client.post(
                        "/chat/completions",
                        headers={"Authorization": f"Bearer {provider.api_key}"},
                        json=retry_body,
                    )
                response.raise_for_status()
                payload = response.json()
                payload["_requestBody"] = request_body
                payload["_reservation"] = reservation
                return payload
        except BaseException:
            if reservation:
                await self.store.release(reservation)
            raise

    def _with_usage(self, result: dict, payload: dict, provider: EditorialProvider) -> dict:
        usage = openai_usage(payload.get("usage"))
        if usage is not None:
            result["_usage"] = usage
        request_body = payload.get("_requestBody") or {}
        reservation = payload.get("_reservation")
        result["_requestBody"] = request_body
        result["_reservation"] = reservation
        result["_estimatedCny"] = reservation.amount if reservation else 0
        result["_usageDay"] = reservation.day if reservation else None
        return result

    @staticmethod
    def _estimated_token_count(value: dict) -> int:
        return max(1, round(len(json.dumps(value, ensure_ascii=False)) / 4))

    async def _record_usage(self, provider: EditorialProvider, body: dict, result: dict) -> None:
        usage = result.get("_usage", {})
        reported = bool(usage)
        request_body = result.get("_requestBody") or body
        visible_result = {key: value for key, value in result.items() if not key.startswith("_")}
        input_tokens = usage.get("input_tokens", 0) if reported else self._estimated_token_count(request_body)
        output_tokens = usage.get("output_tokens", 0) if reported else self._estimated_token_count(visible_result)
        await self.store.record_usage(
            "daily_article", provider.name, provider.model, True,
            input_tokens, output_tokens, reported, result.get("_estimatedCny", 0),
            day=result.get("_usageDay"),
        )

    async def _release_reservation(self, result: dict | None) -> None:
        reservation = (result or {}).pop("_reservation", None)
        if reservation:
            await self.store.release(reservation)

    async def _record_failure(self, provider: EditorialProvider, result: dict | None = None) -> None:
        await self._release_reservation(result)
        await self.store.record_usage(
            "daily_article", provider.name, provider.model, False, 0, 0, False, 0,
        )

    async def generate(
        self,
        topic: str,
        level: str,
        evidence: list[dict[str, Any]],
        *,
        form: str = "explainer",
        word_range: tuple[int, int] | None = None,
    ) -> dict:
        if level not in LEVEL_TARGETS:
            raise ValueError(f"Unsupported CEFR level: {level}")
        if form not in FORM_INSTRUCTIONS:
            raise ValueError(f"Unsupported article form: {form}")
        if word_range is not None and (
            len(word_range) != 2 or word_range[0] <= 0 or word_range[1] < word_range[0]
        ):
            raise ValueError("Invalid article word range")
        started = time.monotonic()
        for provider in self._ranked_providers():
            if not provider.configured or self.cooldown_until.get(provider.name, 0) > time.monotonic():
                continue
            remaining = self.settings.editorial_total_timeout_ms / 1000 - (time.monotonic() - started)
            if remaining <= 0:
                break
            timeout = min(self.settings.editorial_provider_timeout_ms / 1000, remaining)
            provider_started = time.perf_counter()
            result = None
            try:
                result = await asyncio.wait_for(
                    self._call(provider, topic, level, evidence, form=form, word_range=word_range),
                    timeout=timeout,
                )
                validated = self._validate(
                    result,
                    provider,
                    level,
                    len(evidence[:4]),
                    require_learning_assets=True,
                    word_range=word_range,
                )
                metric = self.metrics[provider.name]
                metric["successes"] += 1
                metric["latencyMs"] = round((time.perf_counter() - provider_started) * 1000)
                await self._record_usage(provider, {"topic": topic, "level": level, "evidence": evidence[:4]}, result)
                return validated
            except httpx.HTTPStatusError as error:
                await self._record_failure(provider, result)
                self.metrics[provider.name]["failures"] += 1
                if error.response.status_code == 429:
                    self.cooldown_until[provider.name] = time.monotonic() + 60
            except (asyncio.TimeoutError, TimeoutError):
                await self._record_failure(provider, result)
                self.metrics[provider.name]["failures"] += 1
                self.cooldown_until[provider.name] = time.monotonic() + 20
            except (ValueError, KeyError, IndexError, TypeError, json.JSONDecodeError):
                await self._record_failure(provider, result)
                self.metrics[provider.name]["failures"] += 1
                self.cooldown_until[provider.name] = time.monotonic() + 10
            except BaseException:
                await self._release_reservation(result)
                raise
        raise EditorialUnavailable("所有可用内容模型当前不可用，已保留备用文章池")

    async def intro_zh(self, *, title: str, source: str, topic: str, paragraphs: list[str]) -> str:
        excerpt = " ".join(paragraphs)[:1200]
        fallback = f"一篇来自{source}的{topic}英文原文，未改写，可直接阅读。"
        if not any(provider.configured for provider in self.providers):
            return fallback
        started = time.monotonic()
        for provider in self._ranked_providers():
            if not provider.configured or self.cooldown_until.get(provider.name, 0) > time.monotonic():
                continue
            remaining = 10 - (time.monotonic() - started)
            if remaining <= 0.4:
                break
            result = None
            try:
                result = await asyncio.wait_for(
                    self._call_intro(provider, title, source, topic, excerpt),
                    timeout=min(8.0, remaining),
                )
                intro = str((result or {}).get("introZh") or "").strip()
                intro = re.sub(r"\s+", " ", intro)
                if re.search(r"[\u3400-\u9fff]", intro) and 12 <= len(intro) <= 160:
                    await self._record_usage(provider, {"title": title, "source": source, "topic": topic}, result)
                    return intro
                raise ValueError("Editorial introduction failed validation")
            except Exception:
                await self._record_failure(provider, result)
                self.cooldown_until[provider.name] = time.monotonic() + 15
            except BaseException:
                await self._release_reservation(result)
                raise
        return fallback

    async def english_from_chinese(
        self,
        *,
        title: str,
        topic: str,
        paragraphs: list[str],
        level: str = "B1",
    ) -> dict:
        source = "\n\n".join(paragraphs)[:2400]
        started = time.monotonic()
        last_error: Exception | None = None
        for provider in self._ranked_providers():
            if not provider.configured or self.cooldown_until.get(provider.name, 0) > time.monotonic():
                continue
            remaining = 28 - (time.monotonic() - started)
            if remaining <= 1:
                break
            result = None
            try:
                result = await asyncio.wait_for(
                    self._call_english_from_chinese(provider, title, topic, source, level),
                    timeout=min(22.0, remaining),
                )
                validated = self._validate_english_from_chinese(result)
                await self._record_usage(provider, {"title": title, "topic": topic}, result)
                return validated
            except Exception as error:
                await self._record_failure(provider, result)
                last_error = error
                self.metrics[provider.name]["failures"] += 1
                self.cooldown_until[provider.name] = time.monotonic() + 12
            except BaseException:
                await self._release_reservation(result)
                raise
        raise EditorialUnavailable(str(last_error) if last_error else "无法把中文原文译成控难英语")

    async def _call_english_from_chinese(
        self,
        provider: EditorialProvider,
        title: str,
        topic: str,
        source: str,
        level: str,
    ) -> dict:
        minimum, maximum, level_instruction = LEVEL_TARGETS.get(level, LEVEL_TARGETS["B1"])
        body: dict[str, Any] = {
            "model": provider.model,
            "temperature": 0.15,
            "max_tokens": 2200,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You translate licensed Simplified Chinese encyclopedia excerpts into accurate learner English. "
                        f"Target CEFR {level}. {level_instruction} "
                        "Keep names, dates, numbers and claims exactly as given. Do not invent facts. "
                        "Use natural standard English, not word-for-word Chinglish. Prefer common high-frequency words "
                        "unless a precise term is required. "
                        f"Write {minimum}-{maximum} English words in 3-6 paragraphs. "
                        "Return JSON with title (English), paragraphs (English string array), "
                        "introZh (40-90 Simplified Chinese characters for a reading-app homepage). No markdown."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"title": title, "topic": topic, "source": source},
                        ensure_ascii=False,
                    ),
                },
            ],
        }
        if provider.name in {"zhipu", "deepseek"}:
            body["thinking"] = {"type": "disabled"}
        if provider.name == "modelscope":
            body["enable_thinking"] = False
        payload = None
        try:
            payload = await self._post(provider, body)
            content = payload["choices"][0]["message"].get("content") or ""
            return self._with_usage(self._parse_json(content), payload, provider)
        except BaseException:
            await self._release_reservation(payload)
            raise

    @staticmethod
    def _validate_english_from_chinese(result: dict) -> dict:
        title = re.sub(r"\s+", " ", str(result.get("title") or "")).strip()
        paragraphs = result.get("paragraphs")
        intro = re.sub(r"\s+", " ", str(result.get("introZh") or "")).strip()
        if not title or re.search(r"[\u3400-\u9fff]", title):
            raise ValueError("Translated title must be English")
        if not isinstance(paragraphs, list):
            raise ValueError("Translated article omitted paragraphs")
        paragraphs = [re.sub(r"\s+", " ", str(item)).strip() for item in paragraphs if str(item).strip()]
        if len(paragraphs) < 3:
            raise ValueError("Translated article is too short")
        count = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", " ".join(paragraphs)))
        if count < 180 or count > 720:
            raise ValueError(f"Translated word count {count} is outside 180-720")
        if not re.search(r"[\u3400-\u9fff]", intro) or not (12 <= len(intro) <= 160):
            intro = f"这篇英语课文由中文公开资料译成，适合对照阅读。"
        return {"title": title, "paragraphs": paragraphs, "introZh": intro}

    async def _call_intro(
        self,
        provider: EditorialProvider,
        title: str,
        source: str,
        topic: str,
        excerpt: str,
    ) -> dict:
        body: dict[str, Any] = {
            "model": provider.model,
            "temperature": 0.2,
            "max_tokens": 180,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Write a 40-90 character Simplified Chinese home-page introduction for an English reading app. "
                        "Say what the piece is about and why a learner might read it. Do not translate sentence by sentence. "
                        "No markdown. Return JSON {\"introZh\": \"...\"}."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"title": title, "source": source, "topic": topic, "excerpt": excerpt},
                        ensure_ascii=False,
                    ),
                },
            ],
        }
        if provider.name in {"zhipu", "deepseek"}:
            body["thinking"] = {"type": "disabled"}
        payload = None
        try:
            payload = await self._post(provider, body)
            content = payload["choices"][0]["message"].get("content") or ""
            return self._with_usage(self._parse_json(content), payload, provider)
        except BaseException:
            await self._release_reservation(payload)
            raise

    async def _call(
        self,
        provider: EditorialProvider,
        topic: str,
        level: str,
        evidence: list[dict[str, Any]],
        *,
        form: str = "explainer",
        word_range: tuple[int, int] | None = None,
    ) -> dict:
        minimum, maximum, level_instruction = LEVEL_TARGETS[level]
        if word_range is not None:
            minimum, maximum = word_range
        compact_evidence = [
            {
                "title": item.get("title", ""),
                "publishedAt": item.get("publishedAt", ""),
                "source": item.get("source", ""),
                "url": item.get("url", ""),
                "peerReviewStatus": item.get("peerReviewStatus", "unknown"),
                "evidence": str(item.get("summary", ""))[:2500],
            }
            for item in evidence[:4]
        ]
        system = (
            "You are the editorial writer for Soda Reading, an English learning reader. "
            f"{FORM_INSTRUCTIONS[form]} "
            "Write an original, self-contained English learning article based ONLY on the supplied evidence. "
            "Do not imitate or claim to be the source publication. Do not invent numbers, causes, quotations, "
            "dates, methods, or conclusions. Explain uncertainty and study limitations. The article must have "
            "a clear opening, connected body, and closed conclusion. Return strict JSON with exactly: "
            "title (English string), summaryZh (Simplified Chinese string), paragraphs (array of 3-7 English strings), "
            "sentenceTranslations (object mapping EVERY exact English sentence in paragraphs to a natural Simplified "
            "Chinese translation), glossary (array of 15-25 objects with word, lemma, partOfSpeech, phonetic, "
            "translation, and exact sentence), and factClaims (array of objects with sentence and evidenceIndexes). "
            "Glossary words must occur in the article and prioritize likely difficult, reusable vocabulary. "
            "Each sentence containing a number, date, "
            "study result, comparison, or causal claim must appear verbatim in factClaims and cite one or more supplied "
            "evidence array indexes. "
            "No markdown and no citations inside the prose."
        )
        user = {
            "topic": topic,
            "form": form,
            "targetCefr": level,
            "wordRange": [minimum, maximum],
            "levelGuidance": level_instruction,
            "evidence": compact_evidence,
        }
        body: dict[str, Any] = {
            "model": provider.model,
            "temperature": 0.2,
            "max_tokens": 5000,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
            ],
        }
        if provider.name == "zhipu":
            body["thinking"] = {"type": "disabled"}
        if provider.name == "modelscope":
            body["enable_thinking"] = False
        payload = None
        try:
            payload = await self._post(provider, body)
            content = payload["choices"][0]["message"]["content"]
            return self._with_usage(self._parse_json(content), payload, provider)
        except BaseException:
            await self._release_reservation(payload)
            raise

    @staticmethod
    def _parse_json(content: str) -> dict:
        stripped = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.IGNORECASE).strip()
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            start, end = stripped.find("{"), stripped.rfind("}")
            if start < 0 or end <= start:
                raise
            return json.loads(stripped[start:end + 1])

    @staticmethod
    def _validate(
        result: dict,
        provider: EditorialProvider,
        level: str,
        evidence_count: int,
        require_learning_assets: bool = False,
        word_range: tuple[int, int] | None = None,
    ) -> dict:
        title = str(result.get("title", "")).strip()
        summary = str(result.get("summaryZh", "")).strip()
        paragraphs = result.get("paragraphs")
        if not title or not summary or not isinstance(paragraphs, list):
            raise ValueError("Editorial model omitted required fields")
        paragraphs = [re.sub(r"\s+", " ", str(item)).strip() for item in paragraphs if str(item).strip()]
        if len(paragraphs) < 3:
            raise ValueError("Editorial article has no complete argument structure")
        word_count = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", " ".join(paragraphs)))
        minimum, maximum = word_range or LEVEL_TARGETS[level][:2]
        if word_count < minimum or word_count > maximum:
            raise ValueError(f"Editorial article word count {word_count} is outside {minimum}-{maximum}")
        claims = result.get("factClaims")
        if not isinstance(claims, list):
            raise ValueError("Editorial model omitted factClaims")
        normalized_claims = []
        article_text = " ".join(paragraphs)
        for claim in claims:
            if not isinstance(claim, dict):
                raise ValueError("Invalid fact claim shape")
            sentence = re.sub(r"\s+", " ", str(claim.get("sentence", ""))).strip()
            indexes = claim.get("evidenceIndexes")
            if (
                not sentence
                or sentence not in article_text
                or not isinstance(indexes, list)
                or not indexes
                or any(not isinstance(index, int) or index < 0 or index >= evidence_count for index in indexes)
            ):
                raise ValueError("Fact claim is not traceable to supplied evidence")
            normalized_claims.append({"sentence": sentence, "evidenceIndexes": sorted(set(indexes))})
        traced_sentences = {claim["sentence"] for claim in normalized_claims}
        article_sentences = [
            sentence.strip()
            for paragraph in paragraphs
            for sentence in re.split(r"(?<=[.!?])\s+", paragraph)
            if sentence.strip()
        ]
        for sentence in article_sentences:
            if re.search(
                r"\d|%|\b(found|showed|reported|suggests?|causes?|led to|increased?|decreased?|according to)\b",
                sentence,
                re.IGNORECASE,
            ) and sentence.strip() not in traced_sentences:
                raise ValueError("A factual sentence is missing evidence binding")
        raw_translations = result.get("sentenceTranslations", {})
        translations = {
            re.sub(r"\s+", " ", str(key)).strip(): str(value).strip()
            for key, value in raw_translations.items()
        } if isinstance(raw_translations, dict) else {}
        raw_glossary = result.get("glossary", [])
        glossary = []
        if isinstance(raw_glossary, list):
            for item in raw_glossary:
                if not isinstance(item, dict):
                    continue
                word = str(item.get("word", "")).strip()
                translation = str(item.get("translation", "")).strip()
                sentence = re.sub(r"\s+", " ", str(item.get("sentence", ""))).strip()
                if (
                    word
                    and translation
                    and re.search(r"[\u3400-\u9fff]", translation)
                    and re.search(rf"\b{re.escape(word)}\b", article_text, re.IGNORECASE)
                    and sentence in article_sentences
                ):
                    glossary.append({
                        "word": word,
                        "lemma": str(item.get("lemma", "")).strip(),
                        "partOfSpeech": str(item.get("partOfSpeech", "")).strip(),
                        "phonetic": str(item.get("phonetic", "")).strip(),
                        "translation": translation,
                        "sentence": sentence,
                    })
        if require_learning_assets:
            if (
                len(translations) != len(article_sentences)
                or any(
                    sentence not in translations
                    or not re.search(r"[\u3400-\u9fff]", translations[sentence])
                    for sentence in article_sentences
                )
            ):
                raise ValueError("Editorial model omitted aligned sentence translations")
            if not 15 <= len(glossary) <= 25:
                raise ValueError("Editorial model must provide 15-25 contextual glossary items")
        return {
            "title": title,
            "summary": summary,
            "paragraphs": paragraphs,
            "wordCount": word_count,
            "provider": provider.name,
            "model": provider.model,
            "factClaims": normalized_claims,
            "sentenceTranslations": translations,
            "glossary": glossary,
        }
