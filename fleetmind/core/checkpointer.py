"""
Postgres checkpointer — the persistence layer for the hive mind.

All bots share the same checkpointer instance, keyed by thread_id.
This means any bot can pick up exactly where another left off.
"""

import os
from functools import lru_cache
from langgraph.checkpoint.postgres import PostgresSaver


@lru_cache(maxsize=1)
def get_checkpointer() -> PostgresSaver:
    """
    Return a singleton Postgres checkpointer.

    Reads DATABASE_URL from the environment. Call .setup() once on startup
    to create the required tables.
    """
    db_url = os.environ["DATABASE_URL"]
    saver = PostgresSaver.from_conn_string(db_url)
    saver.setup()
    return saver


def make_thread_id(channel: str, thread_ts: str | None, event_ts: str) -> str:
    """
    Derive a stable LangGraph thread ID from Slack event metadata.

    Uses thread_ts if in a thread, otherwise event_ts — so each top-level
    message and its replies share one thread of state.
    """
    ts = thread_ts or event_ts
    return f"{channel}:{ts}"
