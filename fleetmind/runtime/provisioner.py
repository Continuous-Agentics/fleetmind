"""
Provisioner — generates OpenClaw agent workspaces from fleet.yaml.

This is what `fleetmind deploy` runs. It:
1. Creates a workspace directory per bot
2. Writes SOUL.md, IDENTITY.md, AGENTS.md from the fleet config
3. Writes openclaw config (model, port)
4. Installs declared skills via clawhub
5. Generates a docker-compose.yml for the fleet

OpenClaw is the LLM runtime. FleetMind is the coordination layer on top.
"""

from __future__ import annotations
import json
import subprocess
from pathlib import Path

from ..coordinator.config import FleetConfig, BotConfig


AGENTS_MD_TEMPLATE = """\
# AGENTS.md — {display_name} ({name})

You are the *{display_name}* agent in the *{fleet_name}* FleetMind fleet.

## Your role

{role_description}

## Fleet members

{fleet_table}

## Shared context

All agents share a context store keyed by Slack thread ID.
Read it to understand what other bots have already established in this conversation.

## Memory

- Daily notes: `memory/YYYY-MM-DD.md`
- Long-term: `MEMORY.md`
- Capture decisions, patterns, and client-specific knowledge here.
"""

FLEET_TABLE_HEADER = "| Agent | Display Name | Role |\n|-------|-------------|------|\n"


def _fleet_table(config: FleetConfig, current: BotConfig) -> str:
    rows = []
    for bot in config.bots:
        marker = " *(you)*" if bot.name == current.name else ""
        rows.append(f"| {bot.name} | {bot.emoji} {bot.display_name}{marker} | {bot.role} |")
    return FLEET_TABLE_HEADER + "\n".join(rows)


def _role_description(bot: BotConfig, config: FleetConfig) -> str:
    if bot.role == "orchestrator":
        specialists = ", ".join(
            f"@{b.name} ({b.display_name})" for b in config.specialists
        )
        return (
            f"- First point of contact for humans in Slack\n"
            f"- Route messages to the right specialist based on intent\n"
            f"- Specialists available: {specialists}\n"
            f"- Handle general questions directly"
        )
    else:
        return (
            f"- Specialist agent: answer questions in your domain deeply\n"
            f"- Routed to by the orchestrator when your expertise is needed\n"
            f"- Can also be addressed directly by name in Slack\n"
            f"- Write key findings back to shared context"
        )


def provision_fleet(config: FleetConfig, output_dir: Path, install_skills: bool = True) -> None:
    """
    Generate OpenClaw workspaces for all bots in the fleet.

    output_dir/
      {bot_name}/
        workspace/
          SOUL.md
          IDENTITY.md
          AGENTS.md
          skills/    ← installed by clawhub if install_skills=True
        openclaw.json
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    for bot in config.bots:
        _provision_bot(bot, config, output_dir, install_skills)

    _write_docker_compose(config, output_dir)
    _write_env_template(config, output_dir)

    print(f"\n✅ Fleet '{config.name}' provisioned to {output_dir}/")
    print(f"   {len(config.bots)} bots: {', '.join(b.name for b in config.bots)}")
    print(f"\nNext steps:")
    print(f"  1. Fill in {output_dir}/.env with your Slack tokens")
    print(f"  2. docker compose -f {output_dir}/docker-compose.yml up")


def _provision_bot(bot: BotConfig, config: FleetConfig, output_dir: Path, install_skills: bool) -> None:
    workspace = output_dir / bot.name / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    # SOUL.md
    (workspace / "SOUL.md").write_text(f"# SOUL.md — {bot.display_name}\n\n{bot.soul.strip()}\n")

    # IDENTITY.md
    (workspace / "IDENTITY.md").write_text(
        f"# IDENTITY.md — {bot.display_name}\n\n"
        f"- **Name:** {bot.display_name}\n"
        f"- **Emoji:** {bot.emoji}\n"
        f"- **Role:** {bot.role}\n"
        f"- **Fleet:** {config.name}\n"
    )

    # AGENTS.md
    agents_md = AGENTS_MD_TEMPLATE.format(
        display_name=bot.display_name,
        name=bot.name,
        fleet_name=config.name,
        role_description=_role_description(bot, config),
        fleet_table=_fleet_table(config, bot),
    )
    (workspace / "AGENTS.md").write_text(agents_md)

    # openclaw.json (model + port config)
    oc_config = {
        "agents": {
            "defaults": {
                "workspace": str(workspace.resolve()),
                "model": {"primary": bot.openclaw.model},
            }
        },
        "gateway": {
            "mode": "local",
            "port": bot.openclaw.port,
            "bind": "loopback",
        },
    }
    (output_dir / bot.name / "openclaw.json").write_text(
        json.dumps(oc_config, indent=2)
    )

    # Install skills via clawhub
    if install_skills and bot.skills:
        skills_dir = workspace / "skills"
        skills_dir.mkdir(exist_ok=True)
        for skill in bot.skills:
            print(f"  Installing skill '{skill}' for {bot.name}...")
            result = subprocess.run(
                ["npx", "clawhub@latest", "install", skill],
                cwd=str(workspace),
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                print(f"  ⚠️  Skill '{skill}' install failed: {result.stderr.strip()}")
            else:
                print(f"  ✓ {skill}")

    print(f"  ✓ {bot.emoji} {bot.display_name} → {output_dir}/{bot.name}/")


def _write_docker_compose(config: FleetConfig, output_dir: Path) -> None:
    services: dict = {
        "postgres": {
            "image": "postgres:16",
            "environment": {
                "POSTGRES_USER": "fleetmind",
                "POSTGRES_PASSWORD": "fleetmind",
                "POSTGRES_DB": "fleetmind",
            },
            "ports": ["5432:5432"],
            "volumes": ["postgres_data:/var/lib/postgresql/data"],
            "healthcheck": {
                "test": ["CMD-SHELL", "pg_isready -U fleetmind"],
                "interval": "5s",
                "timeout": "5s",
                "retries": 5,
            },
        }
    }

    for bot in config.bots:
        token_var = f"{bot.name.upper().replace('-', '_')}_SLACK_TOKEN"
        secret_var = f"{bot.name.upper().replace('-', '_')}_SLACK_SIGNING_SECRET"
        app_token_var = f"{bot.name.upper().replace('-', '_')}_SLACK_APP_TOKEN"

        services[bot.name] = {
            "image": "ghcr.io/openclaw/openclaw:latest",
            "environment": {
                "OPENCLAW_STATE_DIR": "/state",
                "OPENCLAW_CONFIG_FILE": "/state/openclaw.json",
                "DATABASE_URL": "postgresql://fleetmind:fleetmind@postgres:5432/fleetmind",
                "SLACK_BOT_TOKEN": f"${{{token_var}}}",
                "SLACK_SIGNING_SECRET": f"${{{secret_var}}}",
                "SLACK_APP_TOKEN": f"${{{app_token_var}}}",
                "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
            },
            "volumes": [f"./{bot.name}:/state"],
            "ports": [f"{bot.openclaw.port}:{bot.openclaw.port}"],
            "depends_on": {"postgres": {"condition": "service_healthy"}},
            "command": ["openclaw", "gateway", "--port", str(bot.openclaw.port)],
        }

    compose = {
        "services": services,
        "volumes": {"postgres_data": None},
    }

    import yaml
    (output_dir / "docker-compose.yml").write_text(yaml.dump(compose, default_flow_style=False))


def _write_env_template(config: FleetConfig, output_dir: Path) -> None:
    lines = [
        "# FleetMind environment variables",
        "# Copy to .env and fill in your values\n",
        "# LLM",
        "ANTHROPIC_API_KEY=sk-ant-...\n",
        "# Database (shared context store)",
        "DATABASE_URL=postgresql://fleetmind:fleetmind@localhost:5432/fleetmind\n",
    ]
    for bot in config.bots:
        prefix = bot.name.upper().replace("-", "_")
        lines += [
            f"# {bot.emoji} {bot.display_name}",
            f"{prefix}_SLACK_TOKEN=xoxb-...",
            f"{prefix}_SLACK_SIGNING_SECRET=...",
            f"{prefix}_SLACK_APP_TOKEN=xapp-...\n",
        ]
    (output_dir / ".env.example").write_text("\n".join(lines))
