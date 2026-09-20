from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.content import ContentService
from app.settings import Settings


@contextmanager
def singleton_lock(service: ContentService):
    connection = service.database.engine.connect()
    acquired = True
    try:
        if service.database.engine.dialect.name == "postgresql":
            acquired = bool(
                connection.execute(
                    text("select pg_try_advisory_lock(hashtext('soda-reading-daily-content'))")
                ).scalar()
            )
        yield acquired
    finally:
        if acquired and service.database.engine.dialect.name == "postgresql":
            connection.execute(
                text("select pg_advisory_unlock(hashtext('soda-reading-daily-content'))")
            )
        connection.close()


async def main() -> int:
    settings = Settings()
    if settings.paid_provider_enabled or settings.daily_paid_budget_cny != 0:
        raise RuntimeError("Zero-cost guard rejected paid-provider configuration")
    if settings.app_env != "production":
        print("warning: APP_ENV is not production", file=sys.stderr)
    service = ContentService(settings)
    requested = int(os.getenv("CONTENT_RUN_LIMIT", str(settings.content_discovery_min)))
    with singleton_lock(service) as acquired:
        if not acquired:
            print(json.dumps({"status": "skipped", "reason": "already_running"}))
            return 0
        result = await service.pipeline.run(
            limit=max(settings.content_discovery_min, requested),
            generate=True,
            publish=True,
        )
        result["activeCefrLevels"] = service.pipeline.active_cefr_levels()
        result["targetEditionOffsetDays"] = settings.content_publish_offset_days
        result["finishedAtShanghai"] = datetime.now(
            ZoneInfo(settings.content_timezone)
        ).isoformat()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result["status"] != "completed":
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
