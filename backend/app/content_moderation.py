from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from .content_sources import RawCandidate
from .model_center import BudgetExceeded, ModelCenterStore, openai_usage
from .provider_config import Provider, load_overrides, provider_definitions, task_provider_order
from .settings import Settings


@dataclass
class RuleModerationDecision:
    blocking_reasons: list[str] = field(default_factory=list)
    review_reasons: list[str] = field(default_factory=list)
    risk_snippets: list[str] = field(default_factory=list)


def _matches(pattern: str, text: str) -> bool:
    return re.search(pattern, text, flags=re.IGNORECASE | re.DOTALL) is not None


HATE_PATTERN = (
    r"\b(?:race|religion|nationality|ethnicity)\b.{0,50}\b(?:inferior|subhuman)\b"
    r"|\b(?:should|must)\s+be\s+hated\b"
)
EXPLICIT_PATTERN = r"\b(?:explicit\s+sex|sex\s+video|pornographic|pornography)\b"
DANGEROUS_PATTERN = (
    r"\bhow\s+to\s+(?:build|make|assemble)\b.{0,80}\b(?:weapon|bomb|explosive)"
    r"|\bstep[- ]by[- ]step\s+instructions\b.{0,100}\b(?:explosive|bomb|weapon)"
)
CLICKBAIT_PATTERN = (
    r"\byou\s+(?:won't|will\s+not)\s+believe\b|\bshocking\s+secret\b"
    r"|\bsecret\s+doctors\s+don't\s+want\s+you\s+to\s+know\b"
)
HEALTH_PATTERN = (
    r"\bguarantees?\s+(?:a\s+)?cure\b|\bmiracle\s+cure\b"
    r"|\bstop\s+taking\b.{0,60}\b(?:medicine|medication)\b"
)


def moderate_candidate_rules(candidate: RawCandidate) -> RuleModerationDecision:
    title = candidate.title or ""
    summary = candidate.summary or ""
    paragraphs = [
        str(paragraph)
        for paragraph in (_candidate_metadata(candidate).get("paragraphs") or [])[:6]
        if str(paragraph).strip()
    ]
    combined = f"{title}\n{summary}\n{' '.join(paragraphs)[:4000]}"
    decision = RuleModerationDecision()

    if _matches(HATE_PATTERN, combined):
        decision.blocking_reasons.append("hate_or_harassment")
    if _matches(EXPLICIT_PATTERN, combined):
        decision.blocking_reasons.append("explicit_content")
    if _matches(DANGEROUS_PATTERN, combined):
        decision.blocking_reasons.append("dangerous_instruction")
    if _matches(CLICKBAIT_PATTERN, combined):
        decision.blocking_reasons.append("sensational_clickbait")
    if _matches(HEALTH_PATTERN, combined):
        decision.review_reasons.append("health_claim_requires_review")
    if candidate.peer_review_status == "preprint":
        decision.review_reasons.append("preprint_requires_context")

    decision.blocking_reasons = list(dict.fromkeys(decision.blocking_reasons))
    decision.review_reasons = list(dict.fromkeys(decision.review_reasons))
    if decision.blocking_reasons or decision.review_reasons:
        decision.risk_snippets = [
            paragraph[:500]
            for paragraph in paragraphs
            if any(
                _matches(pattern, paragraph)
                for pattern in (HATE_PATTERN, EXPLICIT_PATTERN, DANGEROUS_PATTERN, CLICKBAIT_PATTERN, HEALTH_PATTERN)
            )
        ][:2]
    return decision


MODERATION_PROMPT_VERSION = "content-moderation-v2"


def _candidate_metadata(candidate: Any) -> dict:
    return getattr(candidate, "metadata_json", None) or getattr(candidate, "metadata", None) or {}


def moderation_input_hash(candidate: Any) -> str:
    serialized = json.dumps(
        {
            "promptVersion": MODERATION_PROMPT_VERSION,
            "sourceId": getattr(candidate, "source_id", ""),
            "externalId": getattr(candidate, "external_id", ""),
            "title": getattr(candidate, "title", ""),
            "summary": getattr(candidate, "summary", ""),
            "paragraphs": _candidate_metadata(candidate).get("paragraphs") or [],
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _moderation_input(candidate: Any) -> dict:
    metadata = _candidate_metadata(candidate)
    moderation = metadata.get("moderation") or {}
    return {
        "title": str(getattr(candidate, "title", ""))[:240],
        "summary": str(getattr(candidate, "summary", ""))[:1200],
        "source": str(getattr(candidate, "source_id", ""))[:100],
        "topic": str(getattr(candidate, "topic", ""))[:40],
        "peerReviewStatus": str(getattr(candidate, "peer_review_status", "unknown"))[:40],
        "riskFlags": list(moderation.get("ruleReviewReasons") or [])[:8],
        "riskSnippets": [str(item)[:500] for item in (moderation.get("riskSnippets") or [])[:2]],
    }


class ContentModerationGateway:
    def __init__(self, settings: Settings, store: ModelCenterStore | None = None):
        self.settings = settings
        self.store = store or ModelCenterStore()
        overrides = load_overrides()
        definitions = provider_definitions(settings, overrides)
        requested = task_provider_order("content_moderation", settings, overrides)
        self.providers = [
            definitions[name]
            for name in requested
            if name in definitions
            and definitions[name].kind == "openai"
            and self._route_allowed(definitions[name])
        ]

    def _route_allowed(self, provider: Provider) -> bool:
        if not provider.may_charge:
            return True
        return (
            self.settings.paid_provider_enabled
            and self.settings.daily_paid_budget_cny > 0
            and self.settings.paid_request_max_cny > 0
        )

    def _estimated_paid_cost(self, provider: Provider, body: dict) -> float:
        serialized = json.dumps(body, ensure_ascii=False)
        estimated_tokens = max(1, len(serialized) / 4) + int(body.get("max_tokens") or 0)
        cny_per_million = {"deepseek": 8.0, "siliconflow": 8.0}.get(provider.name, 10.0)
        return max(0.0001, estimated_tokens * cny_per_million / 1_000_000)

    async def _post(self, provider: Provider, body: dict) -> dict:
        reservation = None
        if provider.may_charge:
            try:
                reservation = await self.store.reserve(
                    "content_moderation",
                    provider.name,
                    self._estimated_paid_cost(provider, body),
                    self.settings.daily_paid_budget_cny,
                    self.settings.paid_request_max_cny,
                )
            except BudgetExceeded as error:
                raise RuntimeError("moderation_budget_exceeded") from error
        try:
            async with httpx.AsyncClient(
                base_url=provider.base_url,
                timeout=self.settings.content_moderation_timeout_ms / 1000,
            ) as client:
                response = await client.post(
                    "/chat/completions",
                    headers={"Authorization": f"Bearer {provider.api_key}"},
                    json=body,
                )
                response.raise_for_status()
                payload = response.json()
                payload["_reservation"] = reservation
                return payload
        except BaseException:
            if reservation:
                await self.store.release(reservation)
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
    def _validated_result(payload: dict) -> dict:
        decision = payload.get("decision")
        confidence = payload.get("confidence")
        if decision not in {"approve", "reject"}:
            raise ValueError("Invalid moderation decision")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise ValueError("Invalid moderation confidence")
        raw_reasons = payload.get("reasons") or []
        if not isinstance(raw_reasons, list):
            raise ValueError("Invalid moderation reasons")
        reasons = [
            str(reason)[:64]
            for reason in raw_reasons[:6]
            if re.fullmatch(r"[a-z0-9_]{1,64}", str(reason))
        ]
        if decision == "approve" and confidence < 0.85:
            decision = "reject"
            reasons.append("moderation_low_confidence")
        if decision == "reject" and not reasons:
            reasons = ["ai_moderation_rejected"]
        return {
            "decision": decision,
            "confidence": float(confidence),
            "reasons": list(dict.fromkeys(reasons))[:6],
        }

    @staticmethod
    def _estimated_tokens(value: dict) -> int:
        return max(1, round(len(json.dumps(value, ensure_ascii=False)) / 4))

    @staticmethod
    def _unavailable(input_hash: str, provider: Provider | None = None) -> dict:
        return {
            "decision": "reject",
            "confidence": 0,
            "reasons": ["moderation_unavailable"],
            "provider": provider.name if provider else "",
            "model": provider.model if provider else "",
            "inputHash": input_hash,
        }

    async def moderate(self, candidate: Any) -> dict:
        input_hash = moderation_input_hash(candidate)
        provider = next((item for item in self.providers if item.configured), None)
        if provider is None:
            return self._unavailable(input_hash)
        request_input = _moderation_input(candidate)
        body = {
            "model": provider.model,
            "temperature": 0,
            "max_tokens": 180,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Review one English learning-content candidate. Serious, critical, or controversial "
                        "discussion is allowed. Reject only unsupported dangerous advice, hateful or explicit "
                        "material, sensational clickbait, unreliable sourcing, or insufficient evidence. "
                        "Return strict JSON: decision (approve or reject), confidence (0 to 1), "
                        "reasons (up to 6 short lowercase snake_case reason codes)."
                    ),
                },
                {"role": "user", "content": json.dumps(request_input, ensure_ascii=False)},
            ],
        }
        payload = None
        try:
            payload = await self._post(provider, body)
            content = payload["choices"][0]["message"]["content"]
            validated = self._validated_result(self._parse_json(content))
            usage = openai_usage(payload.get("usage"))
            reservation = payload.get("_reservation")
            await self.store.record_usage(
                "content_moderation",
                provider.name,
                provider.model,
                True,
                usage.get("input_tokens", 0) if usage else self._estimated_tokens(body),
                usage.get("output_tokens", 0) if usage else self._estimated_tokens(validated),
                usage is not None,
                reservation.amount if reservation else 0,
                day=reservation.day if reservation else None,
            )
            if reservation:
                await self.store.release(reservation)
            return {
                **validated,
                "provider": provider.name,
                "model": provider.model,
                "inputHash": input_hash,
            }
        except Exception:
            reservation = (payload or {}).get("_reservation")
            if reservation:
                await self.store.release(reservation)
            await self.store.record_usage(
                "content_moderation", provider.name, provider.model, False, 0, 0, False, 0,
            )
            return self._unavailable(input_hash, provider)
        except BaseException:
            reservation = (payload or {}).get("_reservation")
            if reservation:
                await self.store.release(reservation)
            raise
