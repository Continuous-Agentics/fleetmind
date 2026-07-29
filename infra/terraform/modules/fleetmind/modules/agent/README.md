# agent submodule

Provisions one FleetMind bot's AWS footprint:

- **EC2 instance** — Amazon Linux 2023, private subnet, SSM-managed, bootstrapped via `user_data/agent_bootstrap.sh.tpl`.
- **IAM role + instance profile** — least-privilege scoping for SSM, CloudWatch Logs, this agent's secrets, the fleet ContextStore table (optional), and GitHub App SSM params.
- **Secrets Manager secrets** — per-agent placeholders for Slack tokens and the model-provider API key (operator populates real values out-of-band; `lifecycle.ignore_changes` preserves them).

Invoked from the root `terraform-aws-fleetmind` module via `for_each` over agent names. Cross-cutting policies (task-ledger PM/worker grants) are attached separately by the `task-ledger` submodule using this module's `iam_role_name` output.

## Key design choices

- **OpenClaw runtime account.** Bootstrap idempotently creates/reconciles an `openclaw` Unix account (`/home/openclaw`, Bash), installs Node/npm and Docker, grants Docker-group access. Docker is intentionally available for agent tools.
- **User services, not root-owned daemons.** Gateway and NATS subscriber are `systemd --user` units in `/home/openclaw/.config/systemd/user/`. Lingering starts the user manager at boot; start/restart and workspace pulls run as `openclaw` without sudo.
- **Standard OpenClaw home layout.** Deployed workspace lives at `/home/openclaw/.openclaw/workspace` — HOME for the Slack plugin, gateway, and NATS subscriber (`.openclaw` lives there). One agent per host: there is no per-agent workspace subdirectory; `var.name` (the agent id) is preserved only for the systemd service name, Secrets Manager paths, and deploy-artifact identity. This matches the same `~/.openclaw` contract FleetMind's local/ssh targets already use; AWS is no longer a special case. Coordinated with the FleetMind CLI's `workspace_base` default (see the FleetMind PR referenced in `docs/MIGRATIONS.md`).
- **Operator login shell.** `sudo -iu openclaw` loads a generated FleetMind-only profile (`/home/openclaw/.config/fleetmind/openclaw-aliases.sh`). `ocalias` lists commands (`ocstatus`, `oclog`, `octail`, `ocnatsstatus`, `ocnatslog`, `ocnatstail`) — no local operator config/secrets imported.
- **`context_store_table_arn` optional** — empty string skips the DDB IAM policy for non-DDB context-store backends.
- **`shared_secret_arns` (list)** — extra Secrets Manager ARNs to grant read access, typically the RDS-managed master-user secret (`rds!db-<random>`).
- **Hardcoded SSM paths under `/fleetmind/...`** match the agent runtime's expectations — not a variable today.
