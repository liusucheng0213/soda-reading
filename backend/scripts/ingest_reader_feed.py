from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.content import ContentService
from app.settings import Settings


async def main() -> int:
    settings = Settings(content_auto_publish=True, content_prefer_original=True)
    service = ContentService(settings)
    result = await service.pipeline.run(limit=48, generate=True, publish=True)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
