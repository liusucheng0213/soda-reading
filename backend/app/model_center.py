from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .provider_config import TASK_ROUTE_IDS


MODEL_CENTER_PATH = Path(os.environ.get(
    "MODEL_CENTER_PATH",
    Path(__file__).resolve().parent.parent / "data" / "model_center.db",
))


class BudgetExceeded(RuntimeError):
    pass


@dataclass(frozen=True)
class Reservation:
    day: str
    task: str
    provider: str
    amount: float


def openai_usage(payload: dict | None) -> dict | None:
    if not isinstance(payload, dict):
        return None
    input_tokens = payload.get("prompt_tokens")
    output_tokens = payload.get("completion_tokens")
    values = (input_tokens, output_tokens)
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values):
        return None
    return {"input_tokens": input_tokens, "output_tokens": output_tokens}


class ModelCenterStore:
    def __init__(self, path: str | Path = ":memory:"):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._write_lock = asyncio.Lock()
        self._connection.executescript("""
            CREATE TABLE IF NOT EXISTS budget_reservations (
                day TEXT NOT NULL,
                task TEXT NOT NULL,
                provider TEXT NOT NULL,
                amount REAL NOT NULL,
                PRIMARY KEY (day, task, provider)
            );
            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                day TEXT NOT NULL,
                task TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                success INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                tokens_reported INTEGER NOT NULL,
                estimated_cny REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS usage_events_day_task
            ON usage_events(day, task);
            CREATE TABLE IF NOT EXISTS translation_cache (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                expires_at REAL NOT NULL
            );
        """)

    @staticmethod
    def _day() -> str:
        return datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()

    async def reserve(
        self,
        task: str,
        provider: str,
        estimate_cny: float,
        daily_budget_cny: float,
        per_request_max_cny: float,
    ) -> None:
        if estimate_cny < 0:
            raise ValueError("费用估算不能为负数")
        if estimate_cny > per_request_max_cny:
            raise BudgetExceeded("本次调用预计费用超过单次上限")
        day = self._day()
        async with self._write_lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                spent = self._connection.execute(
                    "SELECT COALESCE(SUM(amount), 0) AS total FROM budget_reservations WHERE day = ?",
                    (day,),
                ).fetchone()["total"]
                if spent + estimate_cny > daily_budget_cny:
                    raise BudgetExceeded("今日模型调用预算已用完")
                self._connection.execute("""
                    INSERT INTO budget_reservations(day, task, provider, amount)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(day, task, provider)
                    DO UPDATE SET amount = amount + excluded.amount
                """, (day, task, provider, estimate_cny))
                self._connection.commit()
                return Reservation(day, task, provider, estimate_cny)
            except Exception:
                self._connection.rollback()
                raise

    async def release(self, reservation: Reservation) -> None:
        async with self._write_lock:
            self._connection.execute("""
                UPDATE budget_reservations
                SET amount = MAX(0, amount - ?)
                WHERE day = ? AND task = ? AND provider = ?
            """, (reservation.amount, reservation.day, reservation.task, reservation.provider))
            self._connection.commit()

    def reserved_today_cny(self) -> float:
        row = self._connection.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM budget_reservations WHERE day = ?",
            (self._day(),),
        ).fetchone()
        return round(row["total"], 6)

    async def record_usage(
        self,
        task: str,
        provider: str,
        model: str,
        success: bool,
        input_tokens: int,
        output_tokens: int,
        tokens_reported: bool,
        estimated_cny: float = 0,
        day: str | None = None,
    ) -> None:
        async with self._write_lock:
            self._connection.execute("""
                INSERT INTO usage_events(
                    day, task, provider, model, success,
                    input_tokens, output_tokens, tokens_reported, estimated_cny
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                day or self._day(), task, provider, model, int(success),
                max(0, int(input_tokens)), max(0, int(output_tokens)),
                int(tokens_reported), max(0, float(estimated_cny)),
            ))
            self._connection.commit()

    def usage_summary(self) -> dict[str, dict]:
        summary = {
            task: {
                "attempts": 0,
                "successes": 0,
                "failures": 0,
                "inputTokens": 0,
                "outputTokens": 0,
                "estimatedInputTokens": 0,
                "estimatedOutputTokens": 0,
                "estimatedCny": 0,
            }
            for task in TASK_ROUTE_IDS
        }
        rows = self._connection.execute("""
            SELECT task,
                COUNT(*) AS attempts,
                COALESCE(SUM(success), 0) AS successes,
                COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failures,
                COALESCE(SUM(CASE WHEN tokens_reported = 1 THEN input_tokens ELSE 0 END), 0) AS input_tokens,
                COALESCE(SUM(CASE WHEN tokens_reported = 1 THEN output_tokens ELSE 0 END), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN tokens_reported = 0 THEN input_tokens ELSE 0 END), 0) AS estimated_input,
                COALESCE(SUM(CASE WHEN tokens_reported = 0 THEN output_tokens ELSE 0 END), 0) AS estimated_output,
                COALESCE(SUM(estimated_cny), 0) AS estimated_cny
            FROM usage_events
            WHERE day = ?
            GROUP BY task
        """, (self._day(),)).fetchall()
        for row in rows:
            if row["task"] not in summary:
                continue
            summary[row["task"]] = {
                "attempts": row["attempts"],
                "successes": row["successes"],
                "failures": row["failures"],
                "inputTokens": row["input_tokens"],
                "outputTokens": row["output_tokens"],
                "estimatedInputTokens": row["estimated_input"],
                "estimatedOutputTokens": row["estimated_output"],
                "estimatedCny": round(row["estimated_cny"], 6),
            }
        return summary

    def cache_get(self, key: str) -> dict | None:
        row = self._connection.execute(
            "SELECT value_json, expires_at FROM translation_cache WHERE key = ?",
            (key,),
        ).fetchone()
        if not row:
            return None
        if row["expires_at"] <= time.time():
            self._connection.execute("DELETE FROM translation_cache WHERE key = ?", (key,))
            self._connection.commit()
            return None
        return json.loads(row["value_json"])

    def cache_set(self, key: str, value: dict, ttl_seconds: int) -> None:
        self._connection.execute("""
            INSERT INTO translation_cache(key, value_json, expires_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                expires_at = excluded.expires_at
        """, (key, json.dumps(value, ensure_ascii=False), time.time() + ttl_seconds))
        self._connection.commit()

    def cache_clear(self) -> int:
        count = self._connection.execute("SELECT COUNT(*) AS count FROM translation_cache").fetchone()["count"]
        self._connection.execute("DELETE FROM translation_cache")
        self._connection.commit()
        return count

    def cache_entries(self) -> int:
        self._connection.execute("DELETE FROM translation_cache WHERE expires_at <= ?", (time.time(),))
        self._connection.commit()
        return self._connection.execute("SELECT COUNT(*) AS count FROM translation_cache").fetchone()["count"]
