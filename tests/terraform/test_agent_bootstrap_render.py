#!/usr/bin/env python3
"""Render the agent bootstrap template and assert its runtime-user contract.

This deliberately tests the rendered user data rather than only the .tpl source:
Terraform escaping and template conditionals have broken bootstrap units before.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "infra/terraform/modules/fleetmind/modules/agent/user_data/agent_bootstrap.sh.tpl"


def render() -> str:
    values = {
        "fleet_name": "test-fleet",
        "agent_id": "worker",
        "openclaw_version": "latest",
        "node_version": "24",
        "aws_region": "us-west-2",
        "fleetmind_version": "latest",
        "fleetmind_package": "@continuous-agentics/fleetmind",
        "is_orchestrator": False,
        "gateway_port": 18789,
        "agent_providers": "anthropic",
        "github_apps_json": '["project"]',
    }
    hcl_map = ", ".join(f"{key} = {json.dumps(value)}" for key, value in values.items())
    expression = f"templatefile({json.dumps(str(TEMPLATE))}, {{ {hcl_map} }})\n"

    with tempfile.TemporaryDirectory(prefix="fleetmind-bootstrap-render-") as directory:
        Path(directory, "main.tf").write_text("# Isolated Terraform console context.\n", encoding="utf-8")
        result = subprocess.run(
            ["terraform", f"-chdir={directory}", "console", "-no-color"],
            input=expression,
            text=True,
            capture_output=True,
            check=False,
        )

    if result.returncode:
        raise AssertionError(f"terraform console failed:\n{result.stderr}\n{result.stdout}")

    # Terraform console prints multiline strings as a heredoc. Strip only that
    # display wrapper (whose marker is Terraform-version dependent), then
    # syntax-check the exact rendered shell program.
    heredoc = re.fullmatch(
        r"<<(?P<marker>[A-Za-z_][A-Za-z0-9_]*)\n(?P<body>.*)\n(?P=marker)\n",
        result.stdout,
        flags=re.DOTALL,
    )
    if heredoc is None:
        raise AssertionError(f"Unexpected terraform console string format:\n{result.stdout}")
    rendered = heredoc.group("body")
    shellcheck = subprocess.run(
        ["bash", "-n"], input=rendered, text=True, capture_output=True, check=False
    )
    if shellcheck.returncode:
        raise AssertionError(f"Rendered bootstrap has invalid shell syntax:\n{shellcheck.stderr}")
    return rendered


def section(rendered: str, start: str, end: str) -> str:
    try:
        return rendered.split(start, 1)[1].split(end, 1)[0]
    except IndexError as error:
        raise AssertionError(f"Could not isolate rendered section starting {start!r}") from error


def require(rendered: str, expected: str) -> None:
    if expected not in rendered:
        raise AssertionError(f"Missing rendered user-data assertion:\n{expected}")


def main() -> int:
    rendered = render()

    # Runtime account, npm-capable PATH, and Docker access are all established
    # before OpenClaw is installed or configured. The Unix account home is
    # separate from FleetMind's deployed application-state home.
    for expected in (
        'OPENCLAW_USER="openclaw"',
        'OPENCLAW_HOME="/home/openclaw"',
        'RUNTIME_PATH="/usr/local/bin:/usr/bin:/bin"',
        "dnf install -y git tar unzip jq docker",
        "systemctl enable --now docker",
        "useradd --create-home --home-dir \"$OPENCLAW_HOME\" --shell /bin/bash --groups docker \"$OPENCLAW_USER\"",
        "usermod --home \"$OPENCLAW_HOME\" --move-home --shell /bin/bash --append --groups docker \"$OPENCLAW_USER\"",
        "loginctl enable-linger \"$OPENCLAW_USER\"",
        'install -d -o "$OPENCLAW_USER" -g "$OPENCLAW_USER" -m 0700 "$OPENCLAW_HOME/.config/fleetmind"',
        'chmod 0700 "$OPENCLAW_HOME/.config/fleetmind"',
        "echo \"[bootstrap] npm $(npm --version) available on $RUNTIME_PATH\"",
        'curl -fsSL "https://rpm.nodesource.com/setup_${NODE_VERSION}.x" | bash -',
        "dnf install -y nodejs",
        "npm install -g \"$OPENCLAW_PKG\"",
        'HOOKS_CURRENT=$(aws secretsmanager get-secret-value',
        'if [ -z "$HOOKS_CURRENT" ] || echo "$HOOKS_CURRENT" | grep -q "PENDING_BOOTSTRAP"; then',
        'Webhooks hooks token already populated (not placeholder); leaving it unchanged',
        # Standard OpenClaw layout, one agent per host: the plugin installer's
        # HOME is the OS account home itself, not a nested per-agent workspace.
        "runuser -u \"$OPENCLAW_USER\" -- env HOME=\"$OPENCLAW_HOME\" PATH=\"$RUNTIME_PATH\" openclaw plugins install @openclaw/slack --force",
        # No per-agent subdirectory: the workspace *is* $OPENCLAW_HOME/.openclaw/workspace.
        'WORKSPACE_DIR="$OPENCLAW_HOME/.openclaw/workspace"',
        "APP_TYPE=\"project\"",
        "GitHub App declaration allowlist is missing: $ALLOWLIST",
    ):
        require(rendered, expected)

    if "/opt/openclaw" in rendered:
        raise AssertionError("Rendered bootstrap must not reference the legacy /opt/openclaw workspace path")
    if "WORKSPACE_BASE=\"" in rendered:
        raise AssertionError("Rendered bootstrap must not derive a separate WORKSPACE_BASE (one agent per host)")
    state_handoff = 'chown -R "$OPENCLAW_USER:$OPENCLAW_USER" "$OPENCLAW_HOME/.openclaw"'
    plugin_install = 'runuser -u "$OPENCLAW_USER" -- env HOME="$OPENCLAW_HOME" PATH="$RUNTIME_PATH" openclaw plugins install @openclaw/slack --force'
    require(rendered, state_handoff)
    require(rendered, 'chmod 0700 "$OPENCLAW_HOME/.openclaw"')
    if rendered.index(state_handoff) > rendered.index(plugin_install):
        raise AssertionError("OpenClaw state ownership must be handed off before plugin installation")
    hooks_section = section(rendered, "# ── STAGE 7c", "# ── Secret fetch helper")
    if hooks_section.count("openssl rand -hex 32") != 1 or "HOOKS_CURRENT" not in hooks_section:
        raise AssertionError("Hooks token generation must be guarded by the existing secret value")
    if re.search(r"\.openclaw/workspace/\$\{?AGENT_ID\}?", rendered) or "WORKSPACE_DIR=\"$WORKSPACE_BASE/$AGENT_ID\"" in rendered:
        raise AssertionError("Rendered bootstrap must not nest the workspace under a per-agent-id subdirectory")

    gateway = section(
        rendered,
        'cat > "$USER_SYSTEMD_DIR/openclaw-$AGENT_ID.service" << EOF',
        "# ── STAGE 12b",
    )
    nats = section(
        rendered,
        'cat > "$USER_SYSTEMD_DIR/${NATS_SVC_NAME}.service" << EOF',
        'chown "$OPENCLAW_USER:$OPENCLAW_USER"',
    )

    # Both are systemd *user* units with the OS account's own HOME (standard
    # one-agent-per-host layout — no nested workspace-as-HOME), PATH, and
    # credential file. Neither needs a User= directive or sudo to operate.
    for unit in (gateway, nats):
        require(unit, "WorkingDirectory=$OPENCLAW_HOME")
        require(unit, "Environment=HOME=$OPENCLAW_HOME")
        require(unit, "Environment=PATH=$RUNTIME_PATH")
        require(unit, "EnvironmentFile=-$ENV_FILE")
        if "User=" in unit:
            raise AssertionError("A systemd user unit must not set User=")

    require(gateway, "ConditionPathExists=$OPENCLAW_HOME/.openclaw/openclaw.json")
    require(nats, "Environment=FLEET_YAML=$NATS_FLEET_YAML")
    require(rendered, 'NATS_FLEET_YAML="$WORKSPACE_DIR/fleet.yaml"')

    require(gateway, "ExecStartPre=/usr/local/bin/fetch-agent-secrets $FLEET_NAME $AGENT_ID $ENV_FILE $AWS_REGION")
    require(nats, "ExecStartPre=/usr/local/bin/fetch-agent-secrets $FLEET_NAME $AGENT_ID $ENV_FILE $AWS_REGION")
    require(nats, "Environment=FLEET_YAML=$NATS_FLEET_YAML")
    require(nats, "Environment=OPENCLAW_GATEWAY_PORT=18789")
    require(nats, "Environment=NATS_HEALTH_URL=http://nats.$FLEET_NAME.internal:8222/healthz")
    require(nats, "ExecStart=$FLEETMIND_BIN nats subscribe --mode worker --worker-id $AGENT_ID --json")
    if "sudo" in nats:
        raise AssertionError("Rendered NATS user service must not depend on sudo")

    for expected in (
        'USER_SYSTEMD_DIR="$OPENCLAW_HOME/.config/systemd/user"',
        "systemctl --user daemon-reload",
        'systemctl --user enable --now "openclaw-$AGENT_ID.service"',
        'systemctl --user enable --now "${NATS_SVC_NAME}.path"',
        'OPENCLAW_ALIAS_PROFILE="$OPENCLAW_HOME/.config/fleetmind/openclaw-aliases.sh"',
        'OPENCLAW_BASH_PROFILE="$OPENCLAW_HOME/.bash_profile"',
        "source \"$HOME/.config/fleetmind/openclaw-aliases.sh\"",
        "alias ocalias='alias | grep -E \"^alias (oc|openclaw-)\"'",
        "alias ocstatus='fleetmind_userctl status openclaw-$AGENT_ID.service --no-pager'",
        "alias oclog='fleetmind_userjournal -u openclaw-$AGENT_ID.service -n 100 --no-pager'",
        "alias octail='fleetmind_userjournal -u openclaw-$AGENT_ID.service -f'",
        "alias ocnatsstatus='fleetmind_userctl status ${NATS_SVC_NAME}.service --no-pager'",
        "alias ocnatslog='fleetmind_userjournal -u ${NATS_SVC_NAME}.service -n 100 --no-pager'",
        "alias ocnatstail='fleetmind_userjournal -u ${NATS_SVC_NAME}.service -f'",
    ):
        require(rendered, expected)

    aliases = section(
        rendered,
        'cat > "$OPENCLAW_ALIAS_PROFILE" << EOF',
        'chown "$OPENCLAW_USER:$OPENCLAW_USER" "$OPENCLAW_ALIAS_PROFILE"',
    )
    for expected in (
        "fleetmind_userctl() {",
        "fleetmind_userjournal() {",
        'DBUS_SESSION_BUS_ADDRESS=unix:path=$OPENCLAW_RUNTIME_DIR/bus systemctl --user "\\$@"',
        "alias openclaw-status='ocstatus'",
        "alias openclaw-logs='octail'",
    ):
        require(aliases, expected)
    if "sudo -H -u" in aliases or "/var/log/openclaw" in aliases or "openclaw-gateway" in aliases:
        raise AssertionError("OpenClaw aliases must use FleetMind user units and journald")

    alias_source = 'source "$HOME/.config/fleetmind/openclaw-aliases.sh"'
    if sum(line == alias_source for line in rendered.splitlines()) != 2:
        raise AssertionError("FleetMind aliases must load in both Bash and login-shell profiles")

    # One agent per host: the workspace and $OPENCLAW_HOME/.openclaw/ are both
    # plain children of $OPENCLAW_HOME, not one nested inside the other, so no
    # symlink is ever needed to reconcile them.
    if 'ln -sfn "$WORKSPACE_DIR/.openclaw" "$OPENCLAW_HOME/.openclaw"' in rendered:
        raise AssertionError("Bootstrap must not create a ~/.openclaw symlink")
    if 'HOME="$WORKSPACE_DIR" PATH="$RUNTIME_PATH" openclaw plugins install' in rendered:
        raise AssertionError("Plugin install must use $OPENCLAW_HOME, not the workspace directory, as HOME")

    print("agent bootstrap rendered-user-data assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
