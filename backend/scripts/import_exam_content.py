from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.content_store import ContentDatabase
from app.exam_content import validate_exam_passage
from app.exam_store import ExamContentStore
from app.settings import Settings


def main() -> int:
    if len(sys.argv) != 2:
        print("用法：PYTHONPATH=. python scripts/import_exam_content.py content/exams", file=sys.stderr)
        return 2
    directory = Path(sys.argv[1])
    paths = sorted(directory.glob("*.json"))
    if not paths:
        print("导入失败：目录中没有 JSON 内容包", file=sys.stderr)
        return 1
    payloads = []
    try:
        for path in paths:
            payload = json.loads(path.read_text(encoding="utf-8"))
            validate_exam_passage(payload)
            payloads.append(payload)
        database = ContentDatabase(Settings())
        database.initialize()
        result = ExamContentStore(database).import_passages(payloads)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"导入失败：{type(error).__name__}。请逐篇检查结构、来源和证据句；本批未写入。", file=sys.stderr)
        return 1
    print(json.dumps({
        "added": result["added"],
        "total": len(result["items"]),
        "items": [{
            "id": item["id"],
            "examTrack": item["examTrack"],
            "contentOrigin": item["contentOrigin"],
        } for item in result["items"]],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
