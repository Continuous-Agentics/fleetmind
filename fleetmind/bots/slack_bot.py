"""
SlackBot — wraps a Slack Bolt app around a compiled LangGraph.

Each bot in your fleet gets one SlackBot instance with its own token.
They all share the same `graph` (and therefore the same checkpointer).

Usage:
    bot = SlackBot(
        name="orchestrator",
        token=os.environ["ORCHESTRATOR_SLACK_TOKEN"],
        signing_secret=os.environ["ORCHESTRATOR_SLACK_SIGNING_SECRET"],
        graph=compiled_graph,
        port=3000,
    )
    bot.start()
"""

from __future__ import annotations
import logging
from typing import Any

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from langchain_core.messages import HumanMessage

from ..core.checkpointer import make_thread_id
from ..core.state import SharedState

logger = logging.getLogger(__name__)


class SlackBot:
    """A named Slack bot that routes messages through a shared LangGraph."""

    def __init__(
        self,
        name: str,
        token: str,
        signing_secret: str,
        graph: Any,  # CompiledStateGraph
        app_token: str | None = None,  # For Socket Mode
        port: int = 3000,
    ):
        self.name = name
        self.graph = graph
        self.port = port
        self.app_token = app_token

        self.app = App(token=token, signing_secret=signing_secret)
        self._register_handlers()

    def _register_handlers(self):
        """Register Slack event handlers."""

        @self.app.event("app_mention")
        def handle_mention(event: dict, say, client):
            self._handle_message(event, say, client)

        @self.app.event("message")
        def handle_dm(event: dict, say, client):
            # Only handle DMs (channel_type == "im"), ignore channel noise
            if event.get("channel_type") == "im":
                self._handle_message(event, say, client)

    def _handle_message(self, event: dict, say, client):
        """Process an inbound Slack message through the LangGraph."""
        channel = event["channel"]
        thread_ts = event.get("thread_ts")
        event_ts = event["ts"]
        text = event.get("text", "").strip()

        if not text:
            return

        thread_id = make_thread_id(channel, thread_ts, event_ts)
        config = {"configurable": {"thread_id": thread_id}}

        # Strip bot mention from text if present
        text = self._strip_mention(text)

        logger.info(f"[{self.name}] received: {text!r} (thread={thread_id})")

        try:
            initial_state: SharedState = {
                "messages": [HumanMessage(content=text)],
                "active_agent": self.name,
                "context": {},
                "bot_history": [],
            }

            result = self.graph.invoke(initial_state, config=config)
            response = result["messages"][-1].content

            say(text=response, thread_ts=thread_ts or event_ts)

        except Exception as e:
            logger.error(f"[{self.name}] error: {e}", exc_info=True)
            say(
                text=f"Sorry, something went wrong. ({type(e).__name__})",
                thread_ts=thread_ts or event_ts,
            )

    def _strip_mention(self, text: str) -> str:
        """Remove <@BOTID> mention prefix from message text."""
        import re
        return re.sub(r"^<@[A-Z0-9]+>\s*", "", text).strip()

    def start(self):
        """Start the bot. Uses Socket Mode if app_token is set, else HTTP."""
        if self.app_token:
            logger.info(f"[{self.name}] starting in Socket Mode")
            handler = SocketModeHandler(self.app, self.app_token)
            handler.start()
        else:
            logger.info(f"[{self.name}] starting HTTP on port {self.port}")
            self.app.start(port=self.port)
