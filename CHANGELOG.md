# Changelog

All notable changes to fleetmind are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

### Changed

- **Per-agent Anthropic API key secret** — The Anthropic API key is now provisioned
  per agent at `fleetmind/agents/<name>/anthropic` (was a single shared secret at
  `fleetmind/shared/anthropic`). Matches the existing per-agent Slack token pattern.
  The per-agent IAM role already granted `agents/<name>/*` access, so no IAM change
  was required. After deploy, populate each new secret with:
  ```
  aws secretsmanager put-secret-value \
    --secret-id fleetmind/agents/<name>/anthropic \
    --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'
  ```
  The old `fleetmind/shared/anthropic` secret can be deleted manually after migration.
  Files changed: `secrets.tf`, `outputs.tf`, `user_data/agent_bootstrap.sh.tpl`.
  Deleted: `user_data/bootstrap.sh.tpl` (legacy single-host bootstrap, unreferenced).

### Added

- **WORKER_SWEEP cron seeding** — PM bots can now declare recurring sweep jobs
  directly in `fleet.yaml` under `delegation.sweeps`. `fleetmind deploy` seeds
  them idempotently into `~/.openclaw/cron/jobs.json` on the PM instance.
  No new AWS infrastructure required — scheduling is fully handled by the
  OpenClaw gateway's built-in cron scheduler.
  - New `CronSweepSchema` in `src/config/schema.ts` (`name`, `worker_id`,
    `every` | `cron_expr`, `tz`, `model`, `description`).
  - `provisioner.ts` `seedCronSweeps()` function: reads existing `jobs.json`,
    skips already-registered names (idempotent), appends new sweep jobs,
    writes atomically (temp file + rename).
  - `diffFleet()` reports sweep additions in `fleetmind diff` output.
  - Sweep job IDs are deterministic (SHA-256 of `fleet:agent:sweep-name`)
    so re-deploys on fresh instances produce the same ID and run history
    remains coherent.
  - `fleet.example.yaml` updated with a `sweeps:` example block.
  - `openclaw/pm-bot/workspace/AGENTS.md` documents the `WORKER_SWEEP` procedure.
  - `docs/integration/delegation.md` Step 4 replaced with sweep configuration guide.

## [0.3.0] — 2026-05-08

### Added

- **Delegation feature** — task ledger and CLI for PM-bot-to-worker-bot delegation.
  See [docs/protocol.md](docs/protocol.md) and [docs/integration/delegation.md](docs/integration/delegation.md).
  - CLI subcommands: `fleetmind task <create|ack|ship|block|signoff|abandon|merge|get>`,
    `fleetmind narrative <get|put>`, `fleetmind query <pending|merged|stale>`.
    ([#3](https://github.com/Continuous-Agentics/fleetmind/pull/3))
  - DynamoDB-backed task ledger with conditional-write state machine
    (`delegated → accepted → shipped → signed_off → merged`, plus side
    transitions for `blocked` and `abandoned`).
    ([#3](https://github.com/Continuous-Agentics/fleetmind/pull/3))
  - S3-backed narrative storage with local fallback on write failure.
    ([#3](https://github.com/Continuous-Agentics/fleetmind/pull/3))
  - Wake signaling via DynamoDB Streams → EventBridge Pipe → SSM Run Command.
    ([#3](https://github.com/Continuous-Agentics/fleetmind/pull/3))
  - Terraform module `infra/terraform/modules/task-ledger/` provisioning the
    full substrate: DDB table (with deletion guards, Streams, TTL), S3 bucket,
    IAM policies (`bot-ledger-pm`, `bot-ledger-worker`, `bot-ledger-reader`),
    EventBridge Pipe + DLQs + alarms.
    ([#3](https://github.com/Continuous-Agentics/fleetmind/pull/3))
  - Workspace snippets for PM and worker bots (`openclaw/pm-bot/workspace/`,
    `openclaw/worker-bot/workspace/`) plus role-aware skills
    (`openclaw/skills/bot-delegation/`, `openclaw/skills/bot-reception/`).
    ([#3](https://github.com/Continuous-Agentics/fleetmind/pull/3))
  - `delegation:` block in `fleet.yaml` schema (Zod-validated; required-when-enabled
    cross-field rules via `superRefine`).
    ([#3](https://github.com/Continuous-Agentics/fleetmind/pull/3))
- `--project` passthrough on lifecycle-transition CLI subcommands. When the
  caller already knows the project (typically from a prior `fleetmind task get`),
  passing `--project <slug>` skips the `GetItem` round-trip used to fetch
  project for GSI key updates. Cuts DDB calls per transition from 2 to 1;
  backward-compatible.
  ([#4](https://github.com/Continuous-Agentics/fleetmind/pull/4))
- `.gitignore` patterns for Terraform artifacts (`.terraform/`,
  `.terraform.lock.hcl`, `*.tfstate*`, `*.tfplan`).
  ([#4](https://github.com/Continuous-Agentics/fleetmind/pull/4))

### Changed

- **Architectural rewrite** — replaced the prior LangGraph/Python/multi-process
  architecture with a TypeScript CLI sitting natively on top of OpenClaw's
  multi-agent system. Single OpenClaw gateway with multiple agents defined in
  `fleet.yaml`; native `agentToAgent` messaging handles coordination; no
  separate backend service required.
  ([#2](https://github.com/Continuous-Agentics/fleetmind/pull/2))
- `fleetmind task get` now respects the `--json` flag — default output is a
  compact human-readable summary; full JSON only with `--json`.
  ([#4](https://github.com/Continuous-Agentics/fleetmind/pull/4))
- `fleetmind task create --lifecycle` now validates against
  `requires-human-signoff | shipped-is-done` at parse time (Commander
  `.choices()`) instead of accepting any string.
  ([#4](https://github.com/Continuous-Agentics/fleetmind/pull/4))
- DynamoDB region resolution now fails loud when no region is configured
  (previously silently defaulted to `us-east-1`). Set `delegation.aws_region`
  in `fleet.yaml`, or export `AWS_REGION` / `AWS_DEFAULT_REGION`.
  ([#4](https://github.com/Continuous-Agentics/fleetmind/pull/4))

### Removed

- LangGraph, Python, `uv`, `pyproject.toml`, `psycopg2`, and the
  `docker-compose.yml`-based multi-process architecture.
  ([#2](https://github.com/Continuous-Agentics/fleetmind/pull/2))
