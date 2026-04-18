"""
CLI entry point: python -m fleetmind.bots.run <bot-name>

Loads config from environment, builds the shared graph, and starts
the named bot's Slack listener.
"""

import os
import sys
import logging
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)

from ..core import build_graph, get_checkpointer
from ..agents import OrchestratorAgent
from .slack_bot import SlackBot

# ── Register your agents here ─────────────────────────────────────────────────
# Import and add specialist agents as you build them
def get_agents():
    from ..agents.base import BaseAgent

    class FrontendAgent(BaseAgent):
        name = "frontend-bot"
        system_prompt = (
            "You are a frontend specialist. You know React, CSS, UX patterns, "
            "and browser APIs. Answer frontend questions thoroughly."
        )

    class ApiAgent(BaseAgent):
        name = "api-bot"
        system_prompt = (
            "You are an API and backend specialist. You know REST, GraphQL, "
            "auth patterns, and database design. Answer backend questions thoroughly."
        )

    return [OrchestratorAgent(), FrontendAgent(), ApiAgent()]


# ── Bot configs ────────────────────────────────────────────────────────────────
BOT_CONFIGS = {
    "orchestrator": {
        "token_env": "ORCHESTRATOR_SLACK_TOKEN",
        "secret_env": "ORCHESTRATOR_SLACK_SIGNING_SECRET",
        "port": int(os.getenv("ORCHESTRATOR_PORT", 3000)),
    },
    "frontend-bot": {
        "token_env": "FRONTEND_BOT_SLACK_TOKEN",
        "secret_env": "FRONTEND_BOT_SLACK_SIGNING_SECRET",
        "port": int(os.getenv("FRONTEND_BOT_PORT", 3001)),
    },
    "api-bot": {
        "token_env": "API_BOT_SLACK_TOKEN",
        "secret_env": "API_BOT_SLACK_SIGNING_SECRET",
        "port": int(os.getenv("API_BOT_PORT", 3002)),
    },
}


def main():
    if len(sys.argv) < 2:
        print("Usage: python -m fleetmind.bots.run <bot-name>")
        print(f"Available bots: {', '.join(BOT_CONFIGS)}")
        sys.exit(1)

    bot_name = sys.argv[1]
    if bot_name not in BOT_CONFIGS:
        print(f"Unknown bot: {bot_name}. Available: {', '.join(BOT_CONFIGS)}")
        sys.exit(1)

    cfg = BOT_CONFIGS[bot_name]
    agents = get_agents()
    checkpointer = get_checkpointer()
    graph = build_graph(agents, checkpointer)

    bot = SlackBot(
        name=bot_name,
        token=os.environ[cfg["token_env"]],
        signing_secret=os.environ[cfg["secret_env"]],
        graph=graph,
        app_token=os.getenv("SLACK_APP_TOKEN"),  # Optional: for Socket Mode
        port=cfg["port"],
    )
    bot.start()


if __name__ == "__main__":
    main()
