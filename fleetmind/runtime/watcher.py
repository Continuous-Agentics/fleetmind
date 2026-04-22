"""
FleetMind watcher — GitOps watcher for the versioned skills repo.

Polls a skills repo for version changes and pushes updated skills to agents.
"""

from __future__ import annotations
import json
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from rich.console import Console

from ..coordinator.config import FleetConfig, AgentConfig

console = Console()


@dataclass
class SkillUpdate:
    agent_id: str
    skill_name: str
    old_version: str | None
    new_version: str
    pinned: bool = False  # True = would update but is pinned


class SkillsWatcher:
    """Watches a versioned skills repo and pushes changes to agent workspaces."""

    def __init__(self, fleet: FleetConfig):
        self.fleet = fleet
        self._repo_cache_dir = Path("/tmp/fleetmind-skills-cache")

    def fetch_versions(self) -> dict[str, str]:
        """
        Fetch the versions.json index from the skills repo.
        Returns {skill_name: version} dict.

        Skills repo layout:
          versions.json  ← {\"coding\": \"1.2.0\", \"github\": \"2.1.0\", ...}
          coding/SKILL.md
          coding/package.json
          ...
        """
        repo = self.fleet.skills_repo

        # Local mode — read directly
        if repo.local:
            versions_file = Path(repo.local) / "versions.json"
            if versions_file.exists():
                return json.loads(versions_file.read_text())
            return {}

        # Remote mode — clone/pull the repo
        if not repo.url:
            return {}

        try:
            import git  # gitpython
            if self._repo_cache_dir.exists():
                r = git.Repo(self._repo_cache_dir)
                r.remotes.origin.pull()
            else:
                git.Repo.clone_from(repo.url, self._repo_cache_dir, branch=repo.branch)

            versions_file = self._repo_cache_dir / "versions.json"
            if versions_file.exists():
                return json.loads(versions_file.read_text())
        except ImportError:
            console.print("[yellow]gitpython not installed — cannot fetch remote skills repo[/yellow]")
        except Exception as e:
            console.print(f"[red]Error fetching skills repo:[/red] {e}")

        return {}

    def get_installed_versions(self, agent_id: str) -> dict[str, str]:
        """
        Read installed skill versions from agent workspace.
        Checks {workspace}/skills/{skill}/package.json for version field.
        Returns {skill_name: version}.
        """
        agent = self.fleet.get_agent(agent_id)
        if not agent:
            return {}

        workspace = Path(self.fleet.defaults.workspace_base) / f"workspace-{agent_id}"
        skills_dir = workspace / "skills"
        if not skills_dir.exists():
            return {}

        installed = {}
        for skill_dir in skills_dir.iterdir():
            if not skill_dir.is_dir():
                continue
            pkg_file = skill_dir / "package.json"
            if pkg_file.exists():
                try:
                    pkg = json.loads(pkg_file.read_text())
                    installed[skill_dir.name] = pkg.get("version", "unknown")
                except Exception:
                    installed[skill_dir.name] = "unknown"

        return installed

    def diff(self, agent_id: str, available: dict[str, str]) -> list[SkillUpdate]:
        """
        Compare installed skill versions against available versions.
        Returns list of SkillUpdate objects (respects version pins).
        """
        agent = self.fleet.get_agent(agent_id)
        if not agent:
            return []

        installed = self.get_installed_versions(agent_id)
        updates = []

        for skill_ref in agent.skills:
            name = skill_ref.name
            current = installed.get(name)
            latest = available.get(name)

            if not latest:
                continue  # Skill not in repo

            if skill_ref.version:
                # Pinned — flag but don't auto-update
                if current != skill_ref.version:
                    updates.append(SkillUpdate(
                        agent_id=agent_id,
                        skill_name=name,
                        old_version=current,
                        new_version=skill_ref.version,
                        pinned=True,
                    ))
            else:
                # Unpinned — update to latest
                if current != latest:
                    updates.append(SkillUpdate(
                        agent_id=agent_id,
                        skill_name=name,
                        old_version=current,
                        new_version=latest,
                        pinned=False,
                    ))

        return updates

    def push_skill(self, agent_id: str, skill_name: str, version: str | None = None) -> bool:
        """
        Push a skill to an agent workspace.
        Source: local skills dir or repo cache.
        Returns True if successful.
        """
        agent = self.fleet.get_agent(agent_id)
        if not agent:
            console.print(f"[red]Agent {agent_id} not found[/red]")
            return False

        workspace = Path(self.fleet.defaults.workspace_base) / f"workspace-{agent_id}"
        dest = workspace / "skills" / skill_name

        # Find source
        source = self._find_skill_source(skill_name)
        if not source:
            console.print(f"[red]Skill {skill_name} not found[/red]")
            return False

        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(source, dest)

        console.print(f"[green]✓[/green] Pushed [bold]{skill_name}[/bold] to {agent_id}")
        return True

    def _find_skill_source(self, skill_name: str) -> Path | None:
        """Find skill source directory (local first, then repo cache)."""
        candidates = []

        if self.fleet.skills_repo.local:
            candidates.append(Path(self.fleet.skills_repo.local) / skill_name)

        candidates.append(Path("./skills") / skill_name)

        if self._repo_cache_dir.exists():
            candidates.append(self._repo_cache_dir / skill_name)

        for c in candidates:
            if c.exists():
                return c

        return None

    def _poll_interval_seconds(self) -> int:
        """Parse poll_interval string (e.g. '60s', '5m') to seconds."""
        interval = self.fleet.skills_repo.poll_interval
        if interval.endswith("s"):
            return int(interval[:-1])
        if interval.endswith("m"):
            return int(interval[:-1]) * 60
        if interval.endswith("h"):
            return int(interval[:-1]) * 3600
        return 60

    def watch(self, callback: Callable[[SkillUpdate], None] | None = None) -> None:
        """
        Polling loop. Fetches versions, diffs each agent, calls callback on changes.
        Runs until interrupted (Ctrl+C).
        """
        interval = self._poll_interval_seconds()
        console.print(f"[bold cyan]FleetMind Watch[/bold cyan] — polling every {interval}s")
        console.print(f"  Skills repo: {self.fleet.skills_repo.url or self.fleet.skills_repo.local or '(none)'}")
        console.print("  Press Ctrl+C to stop.\n")

        while True:
            try:
                available = self.fetch_versions()
                if available:
                    console.print(f"[dim]Available skills: {', '.join(f'{k}@{v}' for k,v in available.items())}[/dim]")
                else:
                    console.print("[dim]No skills repo version data found.[/dim]")

                for agent in self.fleet.agents:
                    updates = self.diff(agent.id, available)
                    for update in updates:
                        if update.pinned:
                            console.print(
                                f"[yellow]↔[/yellow] {agent.emoji} {agent.name}: "
                                f"{update.skill_name} pinned@{update.new_version} "
                                f"(installed: {update.old_version or 'none'}) — skipping auto-update"
                            )
                        else:
                            console.print(
                                f"[green]↑[/green] {agent.emoji} {agent.name}: "
                                f"{update.skill_name} {update.old_version or 'none'} → {update.new_version}"
                            )
                            self.push_skill(agent.id, update.skill_name, update.new_version)
                            if callback:
                                callback(update)

                time.sleep(interval)

            except KeyboardInterrupt:
                console.print("\n[dim]Watcher stopped.[/dim]")
                break
