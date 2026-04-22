"""
FleetMind provisioner — creates agent workspaces and installs skills.
"""

from __future__ import annotations
import shutil
from pathlib import Path

from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn

from ..coordinator.config import FleetConfig, AgentConfig, SkillRef

console = Console()

AGENTS_MD_TEMPLATE = """\
# AGENTS.md — {name} ({emoji})

{description}

## Role

{"Orchestrator: coordinates the fleet and delegates to specialist agents." if orchestrator else "Specialist: handles delegated tasks from the orchestrator."}

## Memory

- Daily notes: `memory/YYYY-MM-DD.md`
- Long-term: `MEMORY.md`

## Tools

Skills define available tools. Check TOOLS.md for environment-specific notes.
"""

SOUL_MD_TEMPLATE = """\
# SOUL.md — {name}

{soul}
"""

USER_MD_TEMPLATE = """\
# USER.md — About Your Human

_Populated during onboarding._

- **Name:**
- **Timezone:**
- **Notes:**
"""


def provision_fleet(fleet: FleetConfig, dry_run: bool = False) -> None:
    """Provision all agent workspaces in the fleet."""
    console.print(f"\n[bold cyan]FleetMind[/bold cyan] — provisioning fleet [bold]{fleet.name}[/bold]")
    console.print(f"  Client: {fleet.client}")
    console.print(f"  Agents: {len(fleet.agents)}")
    console.print(f"  Dry run: {dry_run}\n")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        for agent in fleet.agents:
            task = progress.add_task(f"Provisioning {agent.emoji} {agent.name}...", total=None)
            _provision_agent(fleet, agent, dry_run=dry_run)
            progress.update(task, description=f"[green]✓[/green] {agent.emoji} {agent.name}")
            progress.stop_task(task)

    console.print("\n[green]✓ Fleet provisioned.[/green]")
    console.print("  Next: run [bold]fleetmind render[/bold] to generate openclaw.json")


def _provision_agent(fleet: FleetConfig, agent: AgentConfig, dry_run: bool = False) -> None:
    """Provision a single agent's workspace."""
    workspace = Path(fleet.defaults.workspace_base) / f"workspace-{agent.id}"

    if not dry_run:
        workspace.mkdir(parents=True, exist_ok=True)

    # Write SOUL.md
    soul_content = SOUL_MD_TEMPLATE.format(name=agent.name, soul=agent.persona.soul)
    _write_file(workspace / "SOUL.md", soul_content, dry_run)

    # Write AGENTS.md
    agents_content = AGENTS_MD_TEMPLATE.format(
        name=agent.name,
        emoji=agent.emoji,
        description=agent.description,
        orchestrator=agent.orchestrator,
    )
    _write_file(workspace / "AGENTS.md", agents_content, dry_run)

    # Write USER.md (only if it doesn't exist — don't overwrite customized versions)
    user_md = workspace / "USER.md"
    if not user_md.exists():
        _write_file(user_md, USER_MD_TEMPLATE, dry_run)

    # Write IDENTITY.md
    role = "Orchestrator" if agent.orchestrator else "Specialist"
    identity_content = f"""# IDENTITY.md

- **Name:** {agent.name}
- **Emoji:** {agent.emoji}
- **Role:** {role}
- **Description:** {agent.description}
"""
    _write_file(workspace / "IDENTITY.md", identity_content, dry_run)

    # Install skills
    if agent.skills:
        _install_skills(fleet, agent, workspace, dry_run)


def _install_skills(
    fleet: FleetConfig,
    agent: AgentConfig,
    workspace: Path,
    dry_run: bool,
) -> None:
    """Install skills into an agent workspace."""
    skills_dir = workspace / "skills"
    if not dry_run:
        skills_dir.mkdir(exist_ok=True)

    for skill_ref in agent.skills:
        _install_skill(fleet, skill_ref, skills_dir, dry_run)


def _install_skill(
    fleet: FleetConfig,
    skill_ref: SkillRef,
    skills_dir: Path,
    dry_run: bool,
) -> None:
    """Install a single skill. Tries local first, then skills repo."""
    skill_name = skill_ref.name

    # Try local skills dir first
    local_candidates = [
        Path("./skills") / skill_name,
        Path(fleet.skills_repo.local or "") / skill_name if fleet.skills_repo.local else None,
    ]

    for candidate in local_candidates:
        if candidate and candidate.exists():
            if not dry_run:
                dest = skills_dir / skill_name
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(candidate, dest)
            return

    # Skills repo cloning (stub)
    if fleet.skills_repo.url:
        console.print(
            f"    [yellow]→[/yellow] Skill [bold]{skill_name}[/bold]: "
            f"remote install from {fleet.skills_repo.url} (coming soon)"
        )
        return

    console.print(f"    [yellow]⚠[/yellow] Skill [bold]{skill_name}[/bold] not found locally — skipping")


def diff_fleet(fleet: FleetConfig) -> list[str]:
    """Compare what fleet.yaml would deploy vs what's currently on disk. Returns change descriptions."""
    changes = []

    for agent in fleet.agents:
        workspace = Path(fleet.defaults.workspace_base) / f"workspace-{agent.id}"

        if not workspace.exists():
            changes.append(f"[+] Create workspace for {agent.emoji} {agent.name} at {workspace}")
            continue

        soul_path = workspace / "SOUL.md"
        if not soul_path.exists():
            changes.append(f"[+] {agent.name}: create SOUL.md")
        else:
            current = soul_path.read_text()
            expected = SOUL_MD_TEMPLATE.format(name=agent.name, soul=agent.persona.soul)
            if current.strip() != expected.strip():
                changes.append(f"[~] {agent.name}: update SOUL.md")

        skills_dir = workspace / "skills"
        for skill_ref in agent.skills:
            skill_path = skills_dir / skill_ref.name
            if not skill_path.exists():
                ver = f"@{skill_ref.version}" if skill_ref.version else "@latest"
                changes.append(f"[+] {agent.name}: install skill {skill_ref.name}{ver}")

    if not changes:
        changes.append("No changes detected.")

    return changes


def _write_file(path: Path, content: str, dry_run: bool) -> None:
    """Write a file, creating parent dirs. Skips if dry_run."""
    if dry_run:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
