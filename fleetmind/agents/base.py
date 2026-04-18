"""
BaseAgent — extend this for every specialist bot in your fleet.

Minimal implementation:
    class MyAgent(BaseAgent):
        name = "my-agent"
        system_prompt = "You are a specialist in..."

        def get_tools(self):
            return [my_tool_1, my_tool_2]

The base class handles:
- LLM initialization (from environment)
- Tool binding
- LangGraph node execution
- Default routing (return END after running)
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import BaseTool
from langgraph.graph import END

from ..core.state import SharedState


class BaseAgent(ABC):
    """Base class for all FleetMind agents."""

    # Override in subclasses
    name: str = "base-agent"
    system_prompt: str = "You are a helpful assistant."
    model: str = "gpt-4o"

    def __init__(self):
        tools = self.get_tools()
        llm = ChatOpenAI(model=self.model, temperature=0)
        self.llm = llm.bind_tools(tools) if tools else llm
        self.tools = {t.name: t for t in tools}

    def get_tools(self) -> list[BaseTool]:
        """Return the list of tools this agent can use. Override to add tools."""
        return []

    def run(self, state: SharedState) -> dict[str, Any]:
        """
        LangGraph node function. Called when this agent is the active node.

        Builds the message list (system prompt + conversation history),
        invokes the LLM, and returns state updates.
        """
        messages = [SystemMessage(content=self.system_prompt)] + state["messages"]
        response = self.llm.invoke(messages)

        return {
            "messages": [response],
            "active_agent": self.name,
            "bot_history": [self.name],
        }

    def route(self, state: SharedState) -> str:
        """
        Decide what happens after this agent runs.

        Default: return END (done). Override to implement handoff logic.
        The orchestrator overrides this to route to specialists.
        """
        return END
