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


# ── Env var expansion ──────────────────────────────────────────────────────────

def _expand_env(value: str) -> str:
    """Replace ${VAR} with environment variable values."""
    return re.sub(
        r"\$\{([^}]+)\}",
        lambda m: os.environ.get(m.group(1), m.group(0)),
        value,
    )


def _expand(obj):
    """Recursively expand env vars in any structure."""
    if isinstance(obj, str):
        return _expand_env(obj)
    if isinstance(obj, dict):
        return {k: _expand(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_expand(i) for i in obj]
    return obj


# ── Data classes ───────────────────────────────────────────────────────────────

@dataclass
class SkillRef:
    name: str
    version: str | None = None  # None = latest


@dataclass
class SlackAccountConfig:
    account_id: str
    bot_token: str
    app_token: str


@dataclass
class AgentToAgentConfig:
    can_send_to: list[str] = field(default_factory=list)


@dataclass
class PersonaConfig:
    soul: str = "You are a helpful assistant."


@dataclass
class AgentConfig:
    id: str
    name: str
    emoji: str
    description: str
    orchestrator: bool
    persona: PersonaConfig
    slack: SlackAccountConfig
    skills: list[SkillRef] = field(default_factory=list)
    plugins: list[str] = field(default_factory=list)
    agent_to_agent: AgentToAgentConfig = field(default_factory=AgentToAgentConfig)
    model: str | None = None  # None = use fleet default


@dataclass
class SkillsRepoConfig:
    url: str = ""
    branch: str = "main"
    tag: str | None = None
    poll_interval: str = "60s"
    local: str | None = None  # local path for dev mode


@dataclass
class SecretsConfig:
    provider: Literal["env", "aws-ssm", "vault"] = "env"


@dataclass
class OutputsConfig:
    openclaw_json: str = "./rendered/openclaw.json"
    terraform_vars: str = "./rendered/fleet.auto.tfvars"
    workspace_manifests: str = "./rendered/workspaces/"


@dataclass
class GatewayConfig:
    port: int = 18789
    mode: str = "local"
    bind: str = "loopback"


@dataclass
class OpenClawConfig:
    gateway: GatewayConfig = field(default_factory=GatewayConfig)
    dm_scope: str = "per-channel-peer"
    tools_profile: str = "coding"
    web_search_enabled: bool = True
    web_search_provider: str = "brave"
    slack_mode: str = "socket"
    typing_reaction: str = "thinking_face"
    ack_reaction: str = "eyes"
    allow_bots: bool = True
    history_limit: int = 111
    streaming_mode: str = "partial"


@dataclass
class AgentDefaults:
    model: str = "anthropic/claude-sonnet-4-6"
    workspace_base: str = "/home/ec2-user/.openclaw"
    plugins: list[str] = field(default_factory=lambda: ["anthropic"])


@dataclass
class FleetConfig:
    name: str
    version: str
    client: str
    description: str
    agents: list[AgentConfig]
    defaults: AgentDefaults
    skills_repo: SkillsRepoConfig
    secrets: SecretsConfig
    outputs: OutputsConfig
    openclaw: OpenClawConfig

    @classmethod
    def load(cls, path: str | Path) -> "FleetConfig":
        raw = Path(path).read_text()
        data = yaml.safe_load(raw)
        data = _expand(data)

        fleet_meta = data.get("fleet", {})
        defaults_data = data.get("agents", {}).get("defaults", {})
        agents_data = data.get("agents", {}).get("list", [])

        defaults = AgentDefaults(
            model=defaults_data.get("model", "anthropic/claude-sonnet-4-6"),
            workspace_base=defaults_data.get("workspace_base", "/home/ec2-user/.openclaw"),
            plugins=defaults_data.get("plugins", ["anthropic"]),
        )

        agents = []
        for a in agents_data:
            slack_d = a.get("slack", {})
            persona_d = a.get("persona", {})
            a2a_d = a.get("agent_to_agent", {})

            # Parse skills — can be str or dict with name+version
            raw_skills = a.get("skills", [])
            skills = []
            for s in raw_skills:
                if isinstance(s, str):
                    skills.append(SkillRef(name=s))
                elif isinstance(s, dict):
                    skills.append(SkillRef(name=s["name"], version=s.get("version")))

            agents.append(AgentConfig(
                id=a["id"],
                name=a.get("name", a["id"]),
                emoji=a.get("emoji", "🤖"),
                description=a.get("description", ""),
                orchestrator=a.get("orchestrator", False),
                model=a.get("model"),
                persona=PersonaConfig(soul=persona_d.get("soul", "You are a helpful assistant.")),
                slack=SlackAccountConfig(
                    account_id=slack_d.get("account_id", a["id"]),
                    bot_token=slack_d.get("bot_token", ""),
                    app_token=slack_d.get("app_token", ""),
                ),
                skills=skills,
                plugins=a.get("plugins", defaults.plugins),
                agent_to_agent=AgentToAgentConfig(
                    can_send_to=a2a_d.get("can_send_to", []),
                ),
            ))

        # Skills repo
        sr = data.get("skills_repo", {})
        skills_repo = SkillsRepoConfig(
            url=sr.get("url", ""),
            branch=sr.get("branch", "main"),
            tag=sr.get("tag"),
            poll_interval=sr.get("poll_interval", "60s"),
            local=sr.get("local"),
        )

        # Secrets
        sec = data.get("secrets", {})
        secrets = SecretsConfig(provider=sec.get("provider", "env"))

        # Outputs
        out = data.get("outputs", {})
        outputs = OutputsConfig(
            openclaw_json=out.get("openclaw_json", "./rendered/openclaw.json"),
            terraform_vars=out.get("terraform_vars", "./rendered/fleet.auto.tfvars"),
            workspace_manifests=out.get("workspace_manifests", "./rendered/workspaces/"),
        )

        # OpenClaw settings
        oc = data.get("openclaw", {})
        gw = oc.get("gateway", {})
        sl = oc.get("slack", {})
        streaming = sl.get("streaming", {})
        openclaw = OpenClawConfig(
            gateway=GatewayConfig(
                port=gw.get("port", 18789),
                mode=gw.get("mode", "local"),
                bind=gw.get("bind", "loopback"),
            ),
            dm_scope=oc.get("session", {}).get("dm_scope", "per-channel-peer"),
            tools_profile=oc.get("tools", {}).get("profile", "coding"),
            web_search_enabled=oc.get("tools", {}).get("web_search", {}).get("enabled", True),
            web_search_provider=oc.get("tools", {}).get("web_search", {}).get("provider", "brave"),
            slack_mode=sl.get("mode", "socket"),
            typing_reaction=sl.get("typing_reaction", "thinking_face"),
            ack_reaction=sl.get("ack_reaction", "eyes"),
            allow_bots=sl.get("allow_bots", True),
            history_limit=sl.get("history_limit", 111),
            streaming_mode=streaming.get("mode", "partial"),
        )

        return cls(
            name=fleet_meta.get("name", "fleet"),
            version=fleet_meta.get("version", "1.0.0"),
            client=fleet_meta.get("client", ""),
            description=fleet_meta.get("description", ""),
            agents=agents,
            defaults=defaults,
            skills_repo=skills_repo,
            secrets=secrets,
            outputs=outputs,
            openclaw=openclaw,
        )

    @property
    def orchestrator(self) -> AgentConfig | None:
        return next((a for a in self.agents if a.orchestrator), None)

    @property
    def specialists(self) -> list[AgentConfig]:
        return [a for a in self.agents if not a.orchestrator]

    def get_agent(self, agent_id: str) -> AgentConfig | None:
        return next((a for a in self.agents if a.id == agent_id), None)
