"""
Two-bot demo — run locally without Slack to see the graph in action.

This demo shows the orchestrator routing a frontend question to the
frontend-bot specialist, with shared state visible throughout.

Run with:
    DATABASE_URL=postgresql://... OPENAI_API_KEY=sk-... python examples/two_bot_demo.py
"""

import os
from dotenv import load_dotenv
load_dotenv()

from langchain_core.messages import HumanMessage
from fleetmind.core import build_graph, get_checkpointer, SharedState
from fleetmind.agents import OrchestratorAgent
from fleetmind.agents.base import BaseAgent


class FrontendAgent(BaseAgent):
    name = "frontend-bot"
    system_prompt = (
        "You are a frontend specialist. You know React, CSS, and browser APIs. "
        "Give thorough, expert frontend answers."
    )


def main():
    # Build the shared graph
    agents = [OrchestratorAgent(), FrontendAgent()]
    checkpointer = get_checkpointer()
    graph = build_graph(agents, checkpointer)

    thread_id = "demo-channel:1234567890.000001"
    config = {"configurable": {"thread_id": thread_id}}

    print("=== FleetMind Two-Bot Demo ===\n")

    # Message 1: general question — orchestrator handles directly
    print("User: What is FleetMind?")
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="What is FleetMind?")],
            "active_agent": "orchestrator",
            "context": {},
            "bot_history": [],
        },
        config=config,
    )
    print(f"Bot history: {result['bot_history']}")
    print(f"Response: {result['messages'][-1].content}\n")

    # Message 2: frontend question — routes to frontend-bot
    print("User: How do I implement a React useEffect cleanup?")
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="How do I implement a React useEffect cleanup?")],
            "active_agent": "orchestrator",
            "context": {},
            "bot_history": [],
        },
        config=config,
    )
    print(f"Bot history: {result['bot_history']}")
    print(f"Active agent: {result['active_agent']}")
    print(f"Response: {result['messages'][-1].content}\n")

    print("=== Shared state persisted to Postgres ✓ ===")
    print(f"Thread ID: {thread_id}")


if __name__ == "__main__":
    main()
