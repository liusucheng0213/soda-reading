from __future__ import annotations

import json
import os
import sys

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError, ProgrammingError


def record_usage(database_url: str, event_type: str, amount: float, metadata: dict | None = None) -> str:
    """Record one quota event. Returns 'recorded' or 'skipped'.

    The quota table lives in Supabase. A SQLite content database, or a Postgres
    database that has not applied the quota migration, must not fail the caller.
    """
    if event_type not in {"github_action_minutes", "eas_android_build"}:
        raise ValueError("unsupported usage type")
    url = (database_url or "").strip()
    if not url.startswith(("postgres://", "postgresql://")):
        print("platform usage skipped: DATABASE_URL is not Postgres", file=sys.stderr)
        return "skipped"
    payload = metadata or {}
    engine = create_engine(url, pool_pre_ping=True)
    statement = text(
        "insert into platform_usage_events(event_type,amount,metadata) "
        "values (:event_type,:amount,cast(:metadata as jsonb))"
    )
    parameters = {
        "event_type": event_type,
        "amount": max(0.0, float(amount)),
        "metadata": json.dumps(payload),
    }
    try:
        with engine.begin() as connection:
            connection.execute(statement, parameters)
    except (OperationalError, ProgrammingError) as error:
        message = str(error).lower()
        if "platform_usage_events" in message or "does not exist" in message:
            print("platform usage skipped: table is not available", file=sys.stderr)
            return "skipped"
        raise
    return "recorded"


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: record_platform_usage.py TYPE AMOUNT [METADATA_JSON]", file=sys.stderr)
        return 2
    try:
        metadata = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        record_usage(os.environ.get("DATABASE_URL", ""), sys.argv[1], float(sys.argv[2]), metadata)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
