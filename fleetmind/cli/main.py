"""
FleetMind CLI — fleetmind <command>

Commands:
  deploy    Provision OpenClaw workspaces from fleet.yaml
  status    Show fleet status (which bots are running)
  route     Test routing rules against a message (dry run)
  validate  Validate fleet.yaml without deploying
"""

import typer
from pathlib import Path
from rich.console import Console
from rich.table import Table

app = typer.Typer(
    name="fleetmind",
    help="FleetMind — multi-agent coordination platform",
    no_args_is_help=True,
)
console = Console()


@app.command()
def deploy(
    config: Path = typer.Argument(Path("fleet.yaml"), help="Path to fleet.yaml"),
    output: Path = typer.Option(Path("fleet-deploy"), "--output", "-o", help="Output directory"),
    no_skills: bool = typer.Option(False, "--no-skills", help="Skip skill installation"),
):
    """Provision OpenClaw agent workspaces from fleet.yaml."""
    from ..coordinator.config import FleetConfig
    from ..runtime.provisioner import provision_fleet

    if not config.exists():
        console.print(f"[red]Error:[/red] {config} not found.")
        raise typer.Exit(1)

    console.print(f"[bold]FleetMind[/bold] — deploying fleet from [cyan]{config}[/cyan]")
    fleet = FleetConfig.load(config)
    console.print(f"Fleet: [bold]{fleet.name}[/bold] — {len(fleet.bots)} bots")

    provision_fleet(fleet, output, install_skills=not no_skills)


@app.command()
def validate(
    config: Path = typer.Argument(Path("fleet.yaml"), help="Path to fleet.yaml"),
):
    """Validate fleet.yaml structure and required fields."""
    from ..coordinator.config import FleetConfig

    if not config.exists():
        console.print(f"[red]Error:[/red] {config} not found.")
        raise typer.Exit(1)

    try:
        fleet = FleetConfig.load(config)
        console.print(f"[green]✓[/green] Valid fleet config: [bold]{fleet.name}[/bold]")
        console.print(f"  Bots: {', '.join(b.name for b in fleet.bots)}")
        console.print(f"  Routing rules: {len(fleet.routing)}")
        console.print(f"  Context backend: {fleet.context.backend}")
    except Exception as e:
        console.print(f"[red]✗ Invalid config:[/red] {e}")
        raise typer.Exit(1)


@app.command()
def route(
    message: str = typer.Argument(..., help="Message to test routing for"),
    config: Path = typer.Option(Path("fleet.yaml"), "--config", "-c"),
):
    """Test routing rules against a message (dry run, no API calls)."""
    from ..coordinator.config import FleetConfig
    from ..coordinator.router import FleetRouter

    fleet = FleetConfig.load(config)
    router = FleetRouter(fleet)
    explanation = router.explain(message)
    target = router.route(message)

    console.print(f"\n[bold]Message:[/bold] {message}")
    console.print(f"[bold]Decision:[/bold] {explanation}")
    if target:
        console.print(f"[bold]Routes to:[/bold] {target.emoji} {target.display_name}")
    else:
        orch = fleet.orchestrator
        name = f"{orch.emoji} {orch.display_name}" if orch else "orchestrator"
        console.print(f"[bold]Routes to:[/bold] {name} (handles directly)")


@app.command()
def status(
    config: Path = typer.Option(Path("fleet.yaml"), "--config", "-c"),
):
    """Show fleet configuration summary."""
    from ..coordinator.config import FleetConfig

    fleet = FleetConfig.load(config)

    table = Table(title=f"Fleet: {fleet.name}")
    table.add_column("Bot", style="cyan")
    table.add_column("Name")
    table.add_column("Role")
    table.add_column("Port")
    table.add_column("Skills")

    for bot in fleet.bots:
        table.add_row(
            bot.name,
            f"{bot.emoji} {bot.display_name}",
            bot.role,
            str(bot.openclaw.port),
            ", ".join(bot.skills) if bot.skills else "—",
        )

    console.print(table)


def main():
    app()
