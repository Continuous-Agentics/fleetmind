"""
SharedState — the hive mind.

All bots in a fleet read and write to this state via a shared Postgres
checkpointer, keyed by thread_id (channel + thread timestamp).
"""

from typing import Annotated, Any
import operator
from dataclasses import dataclass, field
from langgraph.graph import MessagesState


@dataclass
class FleetMessage:
    """A message in the fleet, tagged with which bot produced it."""
    content: str
    author_bot: str  # e.g. "orchestrator", "frontend-bot"
    role: str = "assistant"  # "user" | "assistant"


class SharedState(MessagesState):
    """
    The shared state passed between all agents in a fleet.

    Extends LangGraph's MessagesState (which handles message list merging)
    with fleet-specific fields.
    """

    # Which agent is currently active / should handle next
    active_agent: str

    # Free-form shared context — decisions, summaries, task state
    # Bots can read this to understand what's happened so far
    context: Annotated[dict[str, Any], lambda a, b: {**a, **b}]

    # Audit trail of which bots have touched this thread
    bot_history: Annotated[list[str], operator.add]
