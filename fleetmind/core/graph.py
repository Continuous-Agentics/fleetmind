"""
Graph builder — wires agents into a LangGraph StateGraph.

Usage:
    from fleetmind.core import build_graph, get_checkpointer
    from fleetmind.agents import OrchestratorAgent, FrontendAgent, ApiAgent

    agents = [OrchestratorAgent(), FrontendAgent(), ApiAgent()]
    app = build_graph(agents, checkpointer=get_checkpointer())
    result = app.invoke(initial_state, config={"configurable": {"thread_id": tid}})
"""

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.base import BaseCheckpointSaver

from .state import SharedState
from ..agents.base import BaseAgent


def build_graph(
    agents: list[BaseAgent],
    checkpointer: BaseCheckpointSaver,
) -> StateGraph:
    """
    Build and compile a LangGraph from a list of agents.

    The first agent in the list is treated as the entry point (orchestrator).
    Routing is determined by each agent's `route()` method, which returns
    the name of the next agent or END.
    """
    if not agents:
        raise ValueError("Must provide at least one agent")

    agent_map = {a.name: a for a in agents}
    graph = StateGraph(SharedState)

    # Register all agents as nodes
    for agent in agents:
        graph.add_node(agent.name, agent.run)

    # Entry point is always the first agent
    graph.set_entry_point(agents[0].name)

    # Wire conditional edges from each agent
    for agent in agents:
        valid_targets = {a.name: a.name for a in agents}
        valid_targets[END] = END

        graph.add_conditional_edges(
            agent.name,
            _make_router(agent),
            valid_targets,
        )

    return graph.compile(checkpointer=checkpointer)


def _make_router(agent: BaseAgent):
    """Return a routing function for a given agent."""
    def router(state: SharedState) -> str:
        return agent.route(state)
    router.__name__ = f"route_{agent.name}"
    return router
