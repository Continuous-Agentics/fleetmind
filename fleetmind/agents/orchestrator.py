"""
OrchestratorAgent — the main entry point for a FleetMind fleet.

Classifies incoming messages and routes to the appropriate specialist,
or handles directly if no specialist is needed.

To customize routing, override `ROUTING_RULES` or `route()`.
"""

from __future__ import annotations
from typing import Any

from langchain_core.messages import SystemMessage
from langgraph.graph import END

from .base import BaseAgent
from ..core.state import SharedState


# Map keyword fragments → specialist agent names.
# Extend or replace this in your subclass.
DEFAULT_ROUTING_RULES: dict[str, str] = {
    "frontend": "frontend-bot",
    "ui": "frontend-bot",
    "design": "frontend-bot",
    "api": "api-bot",
    "endpoint": "api-bot",
    "backend": "api-bot",
}


class OrchestratorAgent(BaseAgent):
    """
    Orchestrator — routes to specialists or handles directly.

    This is always the entry point of the graph. It reads the latest
    user message and decides:
    - Handle it directly (return END)
    - Delegate to a named specialist (return that agent's name)
    """

    name = "orchestrator"
    system_prompt = (
        "You are the orchestrator for a multi-agent system. "
        "You have access to specialist agents for frontend and API topics. "
        "For most questions you answer directly. "
        "For deep frontend or API questions, you hand off to the specialist. "
        "Always be concise and helpful."
    )

    # Subclasses can override this
    routing_rules: dict[str, str] = DEFAULT_ROUTING_RULES

    # Agents known to this orchestrator (populated by build_graph)
    known_agents: list[str] = []

    def run(self, state: SharedState) -> dict[str, Any]:
        """Run the orchestrator — classify intent and prepare routing."""
        self._next_agent = self._classify(state)

        if self._next_agent == END:
            # Handle directly
            return super().run(state)
        else:
            # Just update routing state — the specialist will do the LLM call
            return {
                "active_agent": self._next_agent,
                "bot_history": [self.name],
                "context": {"routed_to": self._next_agent},
            }

    def route(self, state: SharedState) -> str:
        return getattr(self, "_next_agent", END)

    def _classify(self, state: SharedState) -> str:
        """
        Simple keyword-based intent classification.

        Override this with an LLM-based classifier for production use.
        """
        last_message = state["messages"][-1]
        text = (
            last_message.content
            if hasattr(last_message, "content")
            else str(last_message)
        ).lower()

        for keyword, agent_name in self.routing_rules.items():
            if keyword in text:
                return agent_name

        return END  # Handle directly
