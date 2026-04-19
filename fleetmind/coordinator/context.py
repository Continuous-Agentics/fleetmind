"""
ContextStore — the shared hive mind.

All bots in a fleet read and write here. Keyed by thread_id
(Slack channel + thread timestamp). No LangGraph required.

Backends:
  - SQLite (dev/single-server)
  - Postgres (production, multi-server)
  - Redis (high-throughput, optional TTL)
"""

from __future__ import annotations
import json
import time
from typing import Any


class ContextStore:
    """Abstract shared context store. Use make_store() to get an instance."""

    def get(self, thread_id: str) -> dict[str, Any]:
        raise NotImplementedError

    def update(self, thread_id: str, data: dict[str, Any]) -> None:
        raise NotImplementedError

    def append_message(self, thread_id: str, message: dict) -> None:
        ctx = self.get(thread_id)
        messages = ctx.get("messages", [])
        messages.append(message)
        self.update(thread_id, {"messages": messages})

    def get_messages(self, thread_id: str) -> list[dict]:
        return self.get(thread_id).get("messages", [])

    def get_bot_history(self, thread_id: str) -> list[str]:
        return self.get(thread_id).get("bot_history", [])

    def record_bot(self, thread_id: str, bot_name: str) -> None:
        ctx = self.get(thread_id)
        history = ctx.get("bot_history", [])
        history.append(bot_name)
        self.update(thread_id, {"bot_history": history})


class SQLiteContextStore(ContextStore):
    """SQLite backend — good for local dev and single-server deployments."""

    def __init__(self, db_path: str = "fleetmind.db"):
        import sqlite3
        self.db_path = db_path
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._setup()

    def _setup(self):
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS fleet_context (
                thread_id TEXT PRIMARY KEY,
                data      TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        self._conn.commit()

    def get(self, thread_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT data FROM fleet_context WHERE thread_id = ?", (thread_id,)
        ).fetchone()
        return json.loads(row[0]) if row else {}

    def update(self, thread_id: str, data: dict[str, Any]) -> None:
        existing = self.get(thread_id)
        merged = {**existing, **data}
        self._conn.execute(
            """INSERT INTO fleet_context (thread_id, data, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at""",
            (thread_id, json.dumps(merged), time.time()),
        )
        self._conn.commit()


class PostgresContextStore(ContextStore):
    """Postgres backend — for production multi-bot deployments."""

    def __init__(self, dsn: str):
        import psycopg
        self._dsn = dsn
        self._conn = psycopg.connect(dsn, autocommit=True)
        self._setup()

    def _setup(self):
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS fleet_context (
                thread_id  TEXT PRIMARY KEY,
                data       JSONB NOT NULL DEFAULT '{}',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

    def get(self, thread_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT data FROM fleet_context WHERE thread_id = %s", (thread_id,)
        ).fetchone()
        return row[0] if row else {}

    def update(self, thread_id: str, data: dict[str, Any]) -> None:
        self._conn.execute("""
            INSERT INTO fleet_context (thread_id, data, updated_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (thread_id) DO UPDATE
            SET data = fleet_context.data || EXCLUDED.data,
                updated_at = NOW()
        """, (thread_id, json.dumps(data)))


def make_store(backend: str, url: str) -> ContextStore:
    """Factory — returns the right ContextStore for the configured backend."""
    if backend == "postgres":
        return PostgresContextStore(url)
    elif backend == "sqlite":
        db_path = url.replace("sqlite:///", "")
        return SQLiteContextStore(db_path)
    else:
        raise ValueError(f"Unknown context backend: {backend}. Use postgres or sqlite.")
