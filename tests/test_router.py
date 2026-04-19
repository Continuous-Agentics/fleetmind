"""Tests for FleetRouter — routing logic."""

import pytest
from unittest.mock import MagicMock
from fleetmind.coordinator.config import FleetConfig, BotConfig, RoutingRule, OpenClawConfig, SlackConfig, ContextConfig
from fleetmind.coordinator.router import FleetRouter


def make_bot(name, role="specialist"):
    return BotConfig(
        name=name,
        role=role,
        display_name=name.capitalize(),
        emoji="🤖",
        soul="You are helpful.",
        slack=SlackConfig(bot_token="", signing_secret=""),
        openclaw=OpenClawConfig(),
        skills=[],
    )


def make_config():
    return FleetConfig(
        name="test-fleet",
        description="",
        bots=[make_bot("conductor", "orchestrator"), make_bot("pixel"), make_bot("forge")],
        routing=[
            RoutingRule(keywords=["react", "css", "frontend"], to="pixel"),
            RoutingRule(keywords=["api", "database", "backend"], to="forge"),
        ],
        context=ContextConfig(),
    )


def test_routes_frontend_keyword():
    config = make_config()
    router = FleetRouter(config)
    result = router.route("How do I fix this React component?")
    assert result is not None
    assert result.name == "pixel"


def test_routes_backend_keyword():
    config = make_config()
    router = FleetRouter(config)
    result = router.route("What's the best database schema for this?")
    assert result is not None
    assert result.name == "forge"


def test_no_match_returns_none():
    config = make_config()
    router = FleetRouter(config)
    result = router.route("What is the weather today?")
    assert result is None


def test_explain_matched():
    config = make_config()
    router = FleetRouter(config)
    explanation = router.explain("How do I write CSS animations?")
    assert "pixel" in explanation.lower() or "Pixel" in explanation


def test_explain_no_match():
    config = make_config()
    router = FleetRouter(config)
    explanation = router.explain("Tell me a joke")
    assert "directly" in explanation.lower()
