"""
FleetConfig — loads and validates fleet.yaml.

Handles environment variable substitution (${VAR} syntax).
"""

from __future__ import annotations
import os
import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Literal

import yaml


def _expand_env(value: str) -> str:
    """Replace ${VAR} with environment variable values."""
    return re.sub(
        r"\$\{([^}]+)\}",
        lambda m: os.environ.get(m.group(1), m.group(0)),
        value,
    )


def _expand_dict(d: dict) -> dict:
    """Recursively expand env vars in a dict."""
    result = {}
    for k, v in d.items():
        if isinstance(v, str):
            result[k] = _expand_env(v)
        elif isinstance(v, dict):
            result[k] = _expand_dict(v)
        elif isinstance(v, list):
            result[k] = [_expand_env(i) if isinstance(i, str) else i for i in v]
        else:
            result[k] = v
    return result


@dataclass
class SlackConfig:
    bot_token: str
    signing_secret: str
    app_token: str = ""


@dataclass
class OpenClawConfig:
    port: int = 18789
    model: str = "anthropic/claude-sonnet-4-6"


@dataclass
class BotConfig:
    name: str
    role: Literal["orchestrator", "specialist"]
    display_name: str
    emoji: str
    soul: str
    slack: SlackConfig
    openclaw: OpenClawConfig
    skills: list[str] = field(default_factory=list)


@dataclass
class RoutingRule:
    keywords: list[str]
    to: str


@dataclass
class ContextConfig:
    backend: Literal["postgres", "redis", "sqlite"] = "sqlite"
    url: str = "sqlite:///fleetmind.db"


@dataclass
class FleetConfig:
    name: str
    description: str
    bots: list[BotConfig]
    routing: list[RoutingRule]
    context: ContextConfig

    @classmethod
    def load(cls, path: str | Path) -> "FleetConfig":
        raw = Path(path).read_text()
        data = yaml.safe_load(raw)
        data = _expand_dict(data)

        fleet = data["fleet"]
        context_data = data.get("context", {})
        context = ContextConfig(
            backend=context_data.get("backend", "sqlite"),
            url=context_data.get("url", "sqlite:///fleetmind.db"),
        )

        bots = []
        for b in data.get("bots", []):
            slack_data = b.get("slack", {})
            oc_data = b.get("openclaw", {})
            bots.append(BotConfig(
                name=b["name"],
                role=b.get("role", "specialist"),
                display_name=b.get("display_name", b["name"]),
                emoji=b.get("emoji", "🤖"),
                soul=b.get("soul", "You are a helpful assistant."),
                skills=b.get("skills", []),
                slack=SlackConfig(
                    bot_token=slack_data.get("bot_token", ""),
                    signing_secret=slack_data.get("signing_secret", ""),
                    app_token=slack_data.get("app_token", ""),
                ),
                openclaw=OpenClawConfig(
                    port=oc_data.get("port", 18789),
                    model=oc_data.get("model", "anthropic/claude-sonnet-4-6"),
                ),
            ))

        routing = [
            RoutingRule(keywords=r["keywords"], to=r["to"])
            for r in data.get("routing", [])
        ]

        return cls(
            name=fleet["name"],
            description=fleet.get("description", ""),
            bots=bots,
            routing=routing,
            context=context,
        )

    @property
    def orchestrator(self) -> BotConfig | None:
        return next((b for b in self.bots if b.role == "orchestrator"), None)

    @property
    def specialists(self) -> list[BotConfig]:
        return [b for b in self.bots if b.role == "specialist"]
