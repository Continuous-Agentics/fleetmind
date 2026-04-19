"""Tests for ContextStore (SQLite backend)."""

import pytest
import tempfile
import os
from fleetmind.coordinator.context import SQLiteContextStore


@pytest.fixture
def store():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    s = SQLiteContextStore(db_path)
    yield s
    os.unlink(db_path)


def test_get_empty(store):
    assert store.get("thread-1") == {}


def test_update_and_get(store):
    store.update("thread-1", {"foo": "bar"})
    assert store.get("thread-1")["foo"] == "bar"


def test_update_merges(store):
    store.update("thread-1", {"a": 1})
    store.update("thread-1", {"b": 2})
    ctx = store.get("thread-1")
    assert ctx["a"] == 1
    assert ctx["b"] == 2


def test_append_message(store):
    store.append_message("thread-1", {"role": "user", "content": "hello"})
    store.append_message("thread-1", {"role": "assistant", "content": "hi"})
    msgs = store.get_messages("thread-1")
    assert len(msgs) == 2
    assert msgs[0]["content"] == "hello"


def test_record_bot(store):
    store.record_bot("thread-1", "conductor")
    store.record_bot("thread-1", "pixel")
    history = store.get_bot_history("thread-1")
    assert history == ["conductor", "pixel"]


def test_isolated_threads(store):
    store.update("thread-1", {"x": 1})
    store.update("thread-2", {"x": 99})
    assert store.get("thread-1")["x"] == 1
    assert store.get("thread-2")["x"] == 99
