"""
FleetRouter — routes inbound messages to the right bot.

No LangGraph. No external dependencies beyond the fleet config.
Reads routing rules from fleet.yaml and matches against message text.
"""

from __future__ import annotations
import logging
from .config import FleetConfig, BotConfig, RoutingRule

logger = logging.getLogger(__name__)


class FleetRouter:
    """
    Routes messages to specialists based on keyword rules.

    Start simple — keyword matching. Swap in LLM-based classification
    later by overriding `classify()` without changing anything else.
    """

    def __init__(self, config: FleetConfig):
        self.config = config
        self.rules: list[RoutingRule] = config.routing
        self.bot_map: dict[str, BotConfig] = {b.name: b for b in config.bots}

    def route(self, message: str) -> BotConfig | None:
        """
        Given a message, return the specialist BotConfig to handle it,
        or None if the orchestrator should handle it directly.
        """
        target_name = self.classify(message)
        if target_name is None:
            return None
        bot = self.bot_map.get(target_name)
        if bot:
            logger.info(f"Routing to {bot.display_name} ({bot.name})")
        return bot

    def classify(self, message: str) -> str | None:
        """
        Classify a message and return the target bot name, or None.

        Override this method to use an LLM classifier instead of keywords.
        """
        text = message.lower()
        for rule in self.rules:
            if any(kw in text for kw in rule.keywords):
                return rule.to
        return None  # orchestrator handles directly

    def explain(self, message: str) -> str:
        """Return a human-readable explanation of routing decision (for debugging)."""
        text = message.lower()
        for rule in self.rules:
            matched = [kw for kw in rule.keywords if kw in text]
            if matched:
                bot = self.bot_map.get(rule.to)
                name = bot.display_name if bot else rule.to
                return f"Matched keywords {matched} → routing to {name}"
        return "No keywords matched → orchestrator handles directly"
