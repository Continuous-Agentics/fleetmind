# Changelog

All notable changes to fleetmind are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

## [0.5.1] — 2026-05-14

### Added

- **`fleetmind agent connect`** now prints the gateway dashboard URL + auth secret alongside the port-forward output. The wrapper extracts `gateway.auth.mode` + the corresponding password/token from the bot's openclaw config via the existing pre-flight SSM call, displays it with a clear 'credential visible in terminal' note. Auth-mode-aware: handles password / token / no-auth distinctly. ([#153](https://github.com/Continuous-Agentics/fleetmind/pull/153))
- **Per-agent `workspace_base` override** in `AgentSchema`. Bots on custom AMIs that install OpenClaw in a non-default path can declare `workspace_base: /custom/path` per agent; falls back to `agents.defaults.workspace_base`. `agent connect` + the renderer both consult the override consistently.

## [0.5.0] — 2026-05-14

### Added

- **`fleetmind doctor`** — read-only validation of `fleet.yaml` against per-bot-type skill manifests. Reports missing required skills per agent; non-zero exit on errors. ([#142](https://github.com/Continuous-Agentics/fleetmind/pull/142))
- **`fleetmind agent connect <agent>`** — SSM port-forward to a bot's gateway, with pre-flight diagnostics (service status, last-restart time, gateway version, recent log tail) before the tunnel opens. `--skip-preflight` fast-path for when SSM Run Command is the thing being debugged. ([#147](https://github.com/Continuous-Agentics/fleetmind/pull/147))
- **`fleetmind github-app create`** — GitHub App manifest flow: spins up a local HTTPS callback, prints a one-click URL, exchanges the manifest code for App credentials, polls for installation, writes everything to SSM. PEM never lands on operator disk. ([#148](https://github.com/Continuous-Agentics/fleetmind/pull/148))
- **`fleetmind onboard`** Step 5 now uses the `github-app create` manifest flow by default. `--legacy-github-apps` flag falls back to the prompt-driven manual path for headless/CI contexts. ([#148](https://github.com/Continuous-Agentics/fleetmind/pull/148))
- **`fleetmind pull-workspace --bucket <name>`** — override the default `<fleetName>-ledger` snapshot-staging bucket. Useful for audit buckets, cross-account migrations, or dedicated debug-snapshot buckets. Also adds `download-workspace` as a Commander alias. ([#145](https://github.com/Continuous-Agentics/fleetmind/pull/145))
- **Per-bot-type skill manifests** under `openclaw/<bot-type>/skills.yaml`. Each bot type declares the skills required to stand up a bot of that role. Data-only — consumed by `doctor` and `render`. ([#141](https://github.com/Continuous-Agentics/fleetmind/pull/141))
- **`fleetmind render --check` / `--dry-run`** — validate fleet.yaml against manifests without mutating or rendering. CI-friendly. ([#142](https://github.com/Continuous-Agentics/fleetmind/pull/142))
- **`docs/WHERE.md`** in the npm tarball pointing operators at the canonical doc homes after the doc reorg. ([#139](https://github.com/Continuous-Agentics/fleetmind/pull/139))

### Changed

- **`fleetmind render` now mutates `fleet.yaml`** by default to append missing required skills (per each agent's role manifest). Append-only — never removes or modifies existing entries. *Operators running `render` in CI should add `--check`* (read-only) to avoid surprise diffs in the repo. Fully-compliant fleet.yaml = no mutation. ([#142](https://github.com/Continuous-Agentics/fleetmind/pull/142))
- **License**: relicensed from MIT to Apache 2.0 to align with `terraform-aws-fleetmind`. ([#137](https://github.com/Continuous-Agentics/fleetmind/pull/137))
- **Documentation reorg**: operator-facing docs (`QUICKSTART`, `SETUP-A-FLEET`, `MULTI-FLEET`, `OPERATING`, `TROUBLESHOOTING`, `GITHUB-APPS`, `CONCEPTS`) moved out of this repo into [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template). Module-level docs (BYO VPC, standalone task-ledger, migrations) moved into [`terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind). fleetmind keeps CLI runtime + protocol docs only. ([#138](https://github.com/Continuous-Agentics/fleetmind/pull/138), [#139](https://github.com/Continuous-Agentics/fleetmind/pull/139))
- **`agent connect` error message** uses the correct `fleetmind:fleet_name` / `fleetmind:agent_id` tag keys (was unprefixed in the initial draft).

### Changed (potentially breaking for existing fleets)

- **Per-agent EBS workspace volume removed.** Workspace files now live on the
  EC2 root volume at `/opt/openclaw/workspace/<agent_id>/`. Persistent state
  should use the shared substrates (task-ledger DDB, context-store DDB,
  narratives S3) instead.
  - `ec2.tf`: removed `aws_ebs_volume.agent_workspace` + `aws_volume_attachment.agent_workspace`
  - `variables.tf`: removed `workspace_volume_size_gb` + `agent_volume_sizes_gb`
  - `outputs.tf`: removed `workspace_volume_ids`
  - `agent_bootstrap.sh.tpl`: removed EBS detect/mount/fstab block; workspace
    directory is created with `mkdir -p` on the root volume at bootstrap time
  - `fleet.example.yaml`: removed `agent_volume_sizes_gb` override example

  **Migration note for existing fleets:** EBS volumes provisioned by prior
  versions have `prevent_destroy = true`. After applying this change,
  `terraform plan` will show destroy intent for those resources, which
  `prevent_destroy` will block. Two resolution paths:
  1. *(Preferred)* Manually detach and delete the EBS volumes via the AWS
     console before applying this PR, then run `terraform apply`.
  2. Drop the resources from Terraform state without destroying them, then
     delete manually later:
     ```
     terraform state rm 'aws_ebs_volume.agent_workspace["orchestrator"]'
     terraform state rm 'aws_volume_attachment.agent_workspace["orchestrator"]'
     # repeat for each agent
     ```
  For `gg-sandbox` (throwaway environment), path 2 (`terraform state rm`) is
  recommended.

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
