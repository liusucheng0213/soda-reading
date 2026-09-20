from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

from celery import Celery
from celery.schedules import crontab
from redis import Redis

from .content import ContentService
from .settings import Settings


settings = Settings()
celery_app = Celery(
    "soda_reading",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)
celery_app.conf.update(
    timezone=settings.content_timezone,
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
)
celery_app.conf.beat_schedule = {
    "incremental-discovery-every-six-hours": {
        "task": "soda.content.incremental_discovery",
        "schedule": crontab(minute=15, hour="0,6,12,18"),
    },
    "prepare-next-daily-edition": {
        "task": "soda.content.prepare_daily",
        "schedule": crontab(minute=0, hour=21),
    },
    "validate-license-facts-and-freshness": {
        "task": "soda.content.validate_daily",
        "schedule": crontab(minute=0, hour=22),
    },
    "generate-cefr-article-variants": {
        "task": "soda.content.generate_daily",
        "schedule": crontab(minute=30, hour=22),
    },
    "quality-gate-and-risk-routing": {
        "task": "soda.content.quality_gate",
        "schedule": crontab(minute=20, hour=23),
    },
    "check-daily-coverage": {
        "task": "soda.content.check_coverage",
        "schedule": crontab(minute=30, hour=23),
    },
    "publish-daily-edition-at-midnight": {
        "task": "soda.content.publish_daily",
        "schedule": crontab(minute=0, hour=0),
    },
}


@contextmanager
def task_lock(name: str, timeout: int = 7200):
    redis_url = settings.redis_url or settings.celery_broker_url
    client = Redis.from_url(redis_url)
    lock = client.lock(f"soda-reading:{name}", timeout=timeout, blocking_timeout=0)
    acquired = False
    try:
        acquired = lock.acquire(blocking=False)
        yield acquired
    finally:
        if acquired and lock.owned():
            lock.release()


@celery_app.task(name="soda.content.incremental_discovery")
def incremental_discovery() -> dict:
    with task_lock("incremental-discovery") as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "already_running"}
        service = ContentService(Settings())
        limit = max(100, settings.content_discovery_min // 4)
        return asyncio.run(service.pipeline.run(limit=limit, generate=False, publish=False))


@celery_app.task(name="soda.content.prepare_daily")
def prepare_daily() -> dict:
    with task_lock("prepare-daily") as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "already_running"}
        service = ContentService(Settings())
        return asyncio.run(
            service.pipeline.run(
                limit=settings.content_discovery_min,
                generate=False,
                publish=False,
            )
        )


@celery_app.task(name="soda.content.validate_daily")
def validate_daily() -> dict:
    with task_lock("validate-daily", timeout=1800) as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "already_running"}
        service = ContentService(Settings())
        return {"status": "completed", **service.pipeline.audit_state()}


@celery_app.task(name="soda.content.generate_daily")
def generate_daily() -> dict:
    with task_lock("generate-daily") as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "already_running"}
        service = ContentService(Settings())
        generated = asyncio.run(service.pipeline.generate_ready())
        return {
            "status": "generated" if generated else "fallback_pool_retained",
            "generatedCount": generated,
            "paidProvidersEnabled": settings.paid_provider_enabled,
        }


@celery_app.task(name="soda.content.quality_gate")
def quality_gate() -> dict:
    with task_lock("quality-gate", timeout=1800) as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "already_running"}
        service = ContentService(Settings())
        audit = service.pipeline.audit_state()
        return {
            "status": "ready" if audit["articleStatus"].get("approved", 0) else "needs_review",
            **audit,
        }


@celery_app.task(name="soda.content.check_coverage")
def check_coverage() -> dict:
    service = ContentService(Settings())
    latest = service.database.latest_run()
    coverage = latest.topic_coverage if latest else {}
    missing = [topic for topic, count in coverage.items() if count < 5]
    return {
        "status": "ready" if not missing else "needs_attention",
        "missingTopics": missing,
        "coverage": coverage,
        "checkedAt": datetime.now(ZoneInfo(settings.content_timezone)).isoformat(),
    }


@celery_app.task(name="soda.content.publish_daily")
def publish_daily() -> dict:
    with task_lock("publish-daily", timeout=600) as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "already_running"}
        service = ContentService(Settings())
        published = service.pipeline.publish_today()
        return {
            "status": "published" if published else "fallback_pool_retained",
            "publishedCount": published,
            "paidProvidersEnabled": settings.paid_provider_enabled,
        }
