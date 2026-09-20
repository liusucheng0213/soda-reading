from __future__ import annotations

import json
import os
import sys

from sqlalchemy import create_engine, text


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: record_platform_usage.py TYPE AMOUNT [METADATA_JSON]", file=sys.stderr)
        return 2
    event_type = sys.argv[1]
    if event_type not in {"github_action_minutes", "eas_android_build"}:
        raise ValueError("unsupported usage type")
    amount = max(0.0, float(sys.argv[2]))
    metadata = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    database_url = os.environ["DATABASE_URL"]
    engine = create_engine(database_url, pool_pre_ping=True)
    with engine.begin() as connection:
        connection.execute(
            text(
                "insert into platform_usage_events(event_type,amount,metadata) "
                "values (:event_type,:amount,cast(:metadata as jsonb))"
            ),
            {
                "event_type": event_type,
                "amount": amount,
                "metadata": json.dumps(metadata),
            },
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
