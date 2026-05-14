# FleetMind Concepts

A glossary of the vocabulary used across this repo and its docs. Read this first if you're new to fleetmind — most other docs assume you know these terms.

For a guided walkthrough, see [QUICKSTART.md](./QUICKSTART.md). For a comprehensive bring-up reference, see [SETUP-A-FLEET.md](./SETUP-A-FLEET.md).

---

## The big picture

A **fleet** is a set of independent **agents** (AI bots), each running on its own EC2 host with its own OpenClaw **gateway** and Slack identity. Agents coordinate over Slack threads and a shared DynamoDB **ContextStore** — never via shared process state.

You describe the fleet in a single `fleet.yaml`. The fleetmind CLI **renders** that file into per-agent workspace artifacts and Terraform variables, then **pushes** them to each agent's EC2 host. The agents apply the update via **pull-self** and restart their gateway.

When you enable **delegation**, a PM agent (the **orchestrator**) can hand work to **worker** agents through a durable **task ledger**, with a **wake pipeline** notifying the PM when a worker reaches a terminal state.

---

## Fleet

The top-level unit. A fleet has a name (e.g. `acme-bots`), one `fleet.yaml`, one Terraform [workspace](#workspace-disambiguation), and one set of AWS resources (VPC, EC2 hosts, IAM roles, S3 ledger bucket, DynamoDB tables, Secrets Manager paths).

`fleet.name` is the prefix on every AWS resource the fleet creates. Multiple fleets coexist in one AWS account via Terraform workspaces — see [MULTI-FLEET.md](./MULTI-FLEET.md).

## Agent

A single OpenClaw bot. Each agent has:

- An **id** (lowercase, e.g. `blanket`) — appears in SSM paths, systemd unit names, workspace directories
- A **persona** (name, emoji, role, soul)
- Its own **EC2 instance** (isolation > efficiency: a runaway skill on one agent can't starve another)
- Its own OpenClaw **gateway** (systemd unit `openclaw-<agent_id>`)
- Its own **Slack app** (bot token, app token, channels)
- Its own **workspace** (filesystem directory on the EC2)
- A **skill catalog** chosen in `fleet.yaml`

Throughout the codebase and docs, "agent" and "bot" are used interchangeably.

## Orchestrator vs. worker

Two roles, both implemented as agents:

- **Orchestrator** (`orchestrator: true`, conventionally one per fleet) — typically a PM bot. Receives tasks from humans, creates [task ledger](#task-ledger) entries, delegates to workers, and closes the loop. Has the `bot-delegation` skill.
- **Worker** — accepts delegations from the PM, ships work, posts results. Has the `bot-reception` skill. Workers can have a `delegation.specialty` (e.g. `frontend`, `backend`) used by the PM for routing.

Both PM and worker still talk to humans in Slack — "orchestrator" is just a config role, not a different runtime.

## Workspace (disambiguation)

The word "workspace" means two different things:

1. **Agent workspace** — a filesystem directory on the agent's EC2 (`/opt/openclaw/workspace/<agent_id>/`). Source of truth for what OpenClaw runs: `AGENTS.md`, `SOUL.md`, `.openclaw/openclaw.json`, skills, plugins. Mutated by `fleetmind pull-self`.
2. **Terraform workspace** — Terraform's per-environment state isolation. One Terraform workspace per fleet. Created with `terraform workspace new <fleet-name>`.

These are unrelated concepts that happen to share a name. When in doubt, the context makes it clear (agent workspaces hold `.md` files; Terraform workspaces hold `.tfstate`).

## Gateway

The OpenClaw gateway process running on each agent's EC2 host as a systemd unit (`openclaw-<agent_id>.service`). It maintains the Slack socket connection, runs the LLM loop, and exposes the agent's local port for inter-process calls. One gateway per agent — no co-tenancy.

## Persona

Per-agent personality and identity, declared in `fleet.yaml`:

```yaml
persona:
  soul: |
    You are Blanket, a project-manager bot...
```

Rendered into `SOUL.md` in the agent's workspace. The persona shapes how the bot writes and behaves; the [skills](#skill) it has shape what it can *do*.

## Skill

A versioned capability that gives an agent a specific competence (e.g. `coding`, `github`, `bot-delegation`, `bot-reception`). Each skill is a directory containing `SKILL.md` plus optional scripts/templates. Skills are loaded by OpenClaw at gateway startup and on-demand.

Skills have a **source**:

- `fleetmind` — ships bundled in the fleetmind package under `openclaw/skills/`
- `client` — pulled from the operator's external skills repo (see "Skills Repo" in [README.md](../README.md))

Skills can be **pinned** (`version: "2.1.0"`) or unpinned. Unpinned skills auto-update when `fleetmind watch` runs.

## Plugin

Like a skill, but at the gateway level rather than per-task. Plugins are loaded at gateway startup and stay loaded for the life of the process. The canonical plugin is `anthropic` (the LLM provider). Configured in `agents.defaults.plugins` or per-agent.

The distinction: skills are *how the agent solves a specific kind of problem*; plugins are *what the gateway can connect to at all*.

## ContextStore

A DynamoDB-backed shared key/value store ("hive mind") accessible to every agent in a fleet, plus any external service with IAM access. Keys are namespaced:

```text
{fleetName}/{scope}/{key}
```

Common scopes: `shared/` (fleet-wide), `<agent_id>/` (per-agent). CLI: `fleetmind context get|set|delete|list`.

In dev mode (`provider: local`), the store is in-memory only — data does not survive process restart. A warning is printed so you know you're not hitting real DynamoDB.

The table ARN is exported as a Terraform output (`context_store_table_arn`) so external services can be granted IAM access without hardcoding table names.

## Task ledger

A durable record of work delegated from a PM to a worker. Hybrid substrate:

- **DynamoDB** (`{fleet_name}-tasks`) — structured state: status, timestamps, IDs, conditional writes
- **S3** (`{fleet_name}-ledger`) — narrative `.md` content: what got done, what was learned

Task IDs are 8-character lowercase hex. Status enum: `delegated → accepted → shipped → signed_off → merged`, with side transitions to `blocked` or `abandoned`.

For the full schema, IAM model, and conditional-write rules, see [protocol.md](./protocol.md).

## Delegation

The PM-bot-to-worker-bot handoff. When `delegation.enabled: true` in `fleet.yaml`, the PM:

1. Creates a [task ledger](#task-ledger) entry (`PutItem` to DDB)
2. Posts a delegation envelope in a Slack channel mentioning the worker
3. The worker acknowledges (`accepted` state) and ships the work (`shipped` state)
4. The PM is notified via the [wake pipeline](#wake-pipeline) and closes the loop

For setup: [integration/delegation.md](./integration/delegation.md). For protocol details: [protocol.md](./protocol.md).

## Wake pipeline

How a worker's terminal status transition notifies the PM bot across isolated EC2 hosts (no shared process or socket):

```text
Worker UpdateItem (shipped|blocked|abandoned|merged)
  → DDB Stream record
  → EventBridge Pipe (filters terminal statuses)
  → EventBridge rule
  → SSM Run Command on PM's EC2
  → /opt/openclaw/ddb-wake.sh
  → openclaw agent --message "DDB_TERMINAL_WAKE: TASK#<id>"
```

Provisioned by the [`task-ledger`](https://github.com/Continuous-Agentics/fleetmind/tree/main/infra/terraform/modules/task-ledger) Terraform module. The DLQ topology (`{prefix}ledger-pipe-dlq`, `{prefix}ledger-wake-dlq`) catches failures for forensics.

## Sweep

The resilience layer for the wake pipeline. Each PM bot runs cron jobs (seeded into OpenClaw's cron from `fleet.yaml`) that periodically poll DDB for in-flight tasks owned by each worker. If a terminal status was missed by the live wake pipeline (e.g. the PM gateway was restarting when the event fired), the next sweep catches it.

Configured per-PM in `fleet.yaml` under `delegation.sweeps[]`. Typical cadence: every 5 minutes. Sweep jobs live in `~/.openclaw/cron/jobs.json` on the PM instance.

## Lifecycle (`requires-human-signoff` vs. `shipped-is-done`)

Each delegated task carries a lifecycle flag declared at creation:

- **`shipped-is-done`** — the worker's `shipped` state is terminal. The PM closes the loop immediately on wake. Best for low-risk, self-verifiable work.
- **`requires-human-signoff`** — `shipped` triggers a human review step (`signed_off` state) before the task is considered closed. The PM prompts a human in Slack and waits.

Both lifecycles can still transition to `merged` (e.g. when an associated PR merges).

## Render

`fleetmind render <fleet.yaml>` reads the fleet definition and writes:

- `./rendered/openclaw-<fleet>.json` — per-agent `openclaw.json` slices
- `infra/terraform/workspaces/<fleet>.derived.tfvars` — derived Terraform variables (`fleet_name`, `agent_names`, `agent_orchestrators`, `wake_target_session_key`)

Nothing is pushed to EC2. Render is idempotent and safe to re-run. It's what `push fleet` does first under the hood.

The `.derived.tfvars` suffix is intentional: those files are *not* auto-loaded by Terraform — they must be passed explicitly via `-var-file`. This prevents cross-workspace contamination when multiple fleets share an account.

## Push

`fleetmind push fleet [--restart]` is the main deploy command. It runs `render`, packages each agent's workspace into a tarball, uploads tarball + manifest to S3 (`<fleet>-ledger/deploy-staging/`), then triggers `fleetmind pull-self --apply` on each EC2 via SSM Run Command.

With `--restart`, also restarts each agent's gateway after apply.

## Pull-self

`fleetmind pull-self [--apply] [--restart]` is the *bot-side* counterpart to `push`. It runs on the agent's EC2, downloads its tarball + manifest from S3, diffs against the live workspace, and (with `--apply`) atomically applies the changes. Modified files are written to `<dest>.new` then `mv -f` to `<dest>` — POSIX-atomic.

You usually don't run `pull-self` directly: `push fleet` triggers it via SSM. But you can also run it manually (SSH/SSM session) when iterating on a single agent.

## Manifest

A JSON file produced by `push fleet` alongside each tarball:

```json
{
  "agent_id": "blanket",
  "fleet_name": "acme-bots",
  "fleetmind_version": "X.Y.Z",
  "rendered_at": "2026-05-12T21:30:00Z",
  "tarball": { "filename": "blanket.tar.gz", "size_bytes": 92348, "sha256": "..." },
  "files": [ { "path": "AGENTS.md", "size": 4612, "sha256": "...", "mode": 644 }, ... ]
}
```

`pull-self` diffs against `files[]`, not the tarball contents. `tarball.sha256` is verified before extraction to guard against partial uploads.

## Slack identity (account_id, bot_user_id, app/bot tokens)

Each agent has its own Slack app with two tokens:

- **`bot_token`** (`xoxb-…`) — from OAuth & Permissions → Bot User OAuth Token
- **`app_token`** (`xapp-…`) — from Basic Information → App-Level Tokens, with `connections:write` scope (used for socket mode)

Tokens are stored in AWS Secrets Manager under `/fleetmind/<fleet_name>/agents/<agent_id>/…` by `fleetmind secrets populate`.

After tokens are stored, `fleetmind slack discover` calls Slack's `auth.test` to fetch each agent's **`bot_user_id`** (`U…`) and writes it back to `fleet.yaml`. The second render uses these IDs to build per-channel `users` allowlists in `openclaw.json` — without them, peer-bot messages are silently dropped.

## fleetmind vs. openclaw

Two related repos:

- **fleetmind** (this repo) — operator-side CLI + the per-agent workspace artifacts (`openclaw/skills/`, `openclaw/pm-bot/`, etc.) that ship in the package
- **openclaw** — the agent runtime: gateway, agent loop, Slack adapter, LLM plugins. Installed on each agent's EC2 by the bootstrap script.

`fleetmind` produces the inputs (`openclaw.json`, `AGENTS.md`, skills); `openclaw` reads them.
