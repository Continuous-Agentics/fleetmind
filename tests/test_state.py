"""Basic tests for SharedState and graph construction."""

import pytest
from langchain_core.messages import HumanMessage, AIMessage
from fleetmind.core.state import SharedState
from fleetmind.core.checkpointer import make_thread_id


def test_make_thread_id_with_thread():
    tid = make_thread_id("C123", "1234567890.000100", "1234567890.000200")
    assert tid == "C123:1234567890.000100"


def test_make_thread_id_no_thread():
    tid = make_thread_id("C123", None, "1234567890.000200")
    assert tid == "C123:1234567890.000200"


def test_shared_state_structure():
    """SharedState should accept all expected keys."""
    state: SharedState = {
        "messages": [HumanMessage(content="hello")],
        "active_agent": "orchestrator",
        "context": {"foo": "bar"},
        "bot_history": ["orchestrator"],
    }
    assert state["active_agent"] == "orchestrator"
    assert len(state["messages"]) == 1


def test_orchestrator_routing_keyword():
    """Orchestrator should route frontend keywords to frontend-bot."""
    from fleetmind.agents.orchestrator import OrchestratorAgent

    agent = OrchestratorAgent()
    state: SharedState = {
        "messages": [HumanMessage(content="How do I fix this React UI bug?")],
        "active_agent": "orchestrator",
        "context": {},
        "bot_history": [],
    }
    agent.run(state)
    assert agent.route(state) == "frontend-bot"


def test_orchestrator_routing_general():
    """Orchestrator should handle general questions directly (return END)."""
    from fleetmind.agents.orchestrator import OrchestratorAgent
    from langgraph.graph import END

    agent = OrchestratorAgent()
    state: SharedState = {
        "messages": [HumanMessage(content="What is the capital of France?")],
        "active_agent": "orchestrator",
        "context": {},
        "bot_history": [],
    }
    agent._classify(state)  # sets _next_agent without LLM call
    # General question — no keyword match — should END
    assert agent._classify(state) == END
