# Changelog

All notable changes to fleetmind are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

## [0.6.13] — 2026-05-19

### Fixed

- **`fleetmind query all --status` silently returned empty when given comma-separated values without `--project`.** The CLI was passing the full string (e.g. `delegated,accepted,shipped,blocked`) as a single DynamoDB GSI2 key, which matches nothing. Fixed by splitting on commas and fanning out one `queryByStatus` / `queryByProjectStatus` call per status, then merging results. Dispatch logic extracted into an exported `resolveStatusItems` helper so tests exercise the production path directly. ([#188](https://github.com/Continuous-Agentics/fleetmind/pull/188))

## [0.6.5] — 2026-05-18

### Fixed

- **`clawhub` availability check used wrong flag and ignored local `node_modules`.** Two bugs in `resolveClawHub()`: (1) `clawhub --version` exits 1 — the correct flag is `-V`, so the check was always throwing and always reporting "clawhub not found" even when the binary was reachable; (2) `execSync` uses the system PATH which does not include `node_modules/.bin`, so when fleetmind is a local dep in a fleet repo, npm's hoisted `clawhub` binary was never found. Fixed by switching to `-V` and augmenting PATH with both the hoisted (`<fleet-repo>/node_modules/.bin`) and nested (`<fleetmind>/node_modules/.bin`) bin locations. Both fixes verified with isolated node tests before merging. ([#171](https://github.com/Continuous-Agentics/fleetmind/pull/171))

## [0.6.4] — 2026-05-18

### Fixed

- **`clawhub` CLI now ships as a declared dependency.** `src/runtime/resolver.ts` shells out to `clawhub install` when provisioning skills with `source: clawhub`. Previously the CLI was assumed to be a manual global install, causing `fleetmind push fleet` to fail with `'clawhub' CLI not found` on any host where it hadn't been pre-installed. Adding `clawhub@^0.16.0` to `dependencies` ensures it is available wherever `fleetmind` is installed. Updated the not-found error message to reflect the correct remediation. ([#170](https://github.com/Continuous-Agentics/fleetmind/pull/170))

## [0.6.3] — 2026-05-15

### Added

- **`MEMORY.md` template** — added to all four bot types with an AUTO-tagged `## Active Tasks` section. Shipped on every push; section merge updates AUTO sections while preserving bot-written content. ([#167](https://github.com/Continuous-Agentics/fleetmind/pull/167))

### Removed

- **`PATCHES.md` templates** — removed from all bot types. The patch mechanism was a workaround for files overwritten on every push; section merge makes it redundant. Patch engine in `pull-self` retained (harmless, idempotent on agents with existing `PATCHES.md`). ([#167](https://github.com/Continuous-Agentics/fleetmind/pull/167))

## [0.6.2] — 2026-05-15

### Fixed

- **`provisionAgent` resolved role templates against `process.cwd()` instead of the package root** — when the operator runs `fleetmind push fleet` from their fleet repo, `process.cwd()` is the fleet repo (no `openclaw/` subdir). `SOUL.md`/`AGENTS.md`/`IDENTITY.md` were unaffected because they fall back to inline generators when the template is null. `HEARTBEAT.md` and `PATCHES.md` have no fallback so they were silently excluded from the rendered workspace and the push-fleet manifest. Fixed by resolving from `import.meta.url` → package installation root. ([#166](https://github.com/Continuous-Agentics/fleetmind/pull/166))

## [0.6.1] — 2026-05-15

### Fixed

- **`.config/` missing from `PROTECTED_PATHS`** — `.config/` is agent-generated (configstore, pip, git config state) and was being shown as deleted on push. Added alongside `.cache/`, `.local/`, `.npm/`. ([#165](https://github.com/Continuous-Agentics/fleetmind/pull/165))
- **`HEARTBEAT.md` and `PATCHES.md` not included in push-fleet manifest** — Both templates existed in `openclaw/*/workspace/` but `provisionAgent` never wrote them to `rendered/workspaces/<agent>/`, so they never reached the push-fleet S3 manifest and appeared as deleted on agents. Wired both into `provisionAgent` using the same `readRoleTemplate` pattern as `SOUL.md`/`AGENTS.md`/`IDENTITY.md`. Added regression test. ([#165](https://github.com/Continuous-Agentics/fleetmind/pull/165))

## [0.6.0] — 2026-05-15

### Added

- **Agent-owned file protection in `pull-self`.** `PROTECTED_PATHS` constant guards `memory/`, `.openclaw/`, `.cache/`, `.local/`, `.npm/`, `USER.md`, and `TOOLS.md` from deletion and modification during `push fleet --apply`. Protection is applied at two layers: `computeDiff` (primary — protected files never appear as deletion candidates) and `applyDiff` (defence-in-depth — also guarded in the modified loop). Agent memory and runtime state now survive every push. ([#164](https://github.com/Continuous-Agentics/fleetmind/pull/164))
- **Section-aware merge for `.md` workspace files.** Operator-managed sections are marked with `<!-- AUTO SECTION -->` on the line before any `##` heading. On `pull-self --apply`, AUTO-tagged sections are always taken from the incoming manifest (operator wins); untagged sections added by bots are preserved. `MEMORY.md` participates in the merge (not hard-protected) so operators can push fleet facts into it. Merge separator is inferred from the incoming file to prevent sha256 drift on repeated pushes (idempotent). ([#164](https://github.com/Continuous-Agentics/fleetmind/pull/164))
- **`<!-- AUTO SECTION -->` tagging across all role templates.** All `##` sections in `AGENTS.md`, `SOUL.md`, `PATCHES.md`, and new `HEARTBEAT.md` templates tagged for worker-bot, pm-bot, backend-worker-bot, and frontend-worker-bot. New `HEARTBEAT.md` template added to all bot types. ([#164](https://github.com/Continuous-Agentics/fleetmind/pull/164))

### Fixed

- **`push-fleet --upgrade-cli` now uses SSM Automation document for two-step sequencing.** Previously, upgrade + pull-self were chained in a single shell string with `|| true`, which silently swallowed upgrade failures and ran pull-self against a stale CLI. Now uses an SSM Automation document (`fleetmind-upgrade-<fleet>`) that sequences the steps server-side: upgrade CLI → verify → pull-self. Operator fires one call and monitors via `AutomationExecutionId`; no operator-side polling required. ([#162](https://github.com/Continuous-Agentics/fleetmind/pull/162))
- **New `automation-doc` command** manages the SSM Automation document lifecycle (create/update, default-version advancement, content-hash comparison guarded against SSM JSON reformatting). ([#162](https://github.com/Continuous-Agentics/fleetmind/pull/162))

## [0.5.3] — 2026-05-15

### Added

- **`cacheRetention` support in `fleet.yaml`** — `agents.defaults.params.cacheRetention` and `agents.defaults.models.<model>.params.cacheRetention` are now schema-validated and forwarded to each agent's rendered `openclaw.json`. Supported values: `none` | `short` | `long`. Recommended defaults for Anthropic fleets: `short` globally, `long` for `anthropic/claude-sonnet-4-6`. Without this, every agent turn re-processed the full system prompt at full cost. ([#159](https://github.com/Continuous-Agentics/fleetmind/pull/159))

## [0.5.2] — 2026-05-14

### Added

- **Fleet-wide `COMPANY.md` distribution.** Operators populate `COMPANY.md` once at their fleet repo root (next to `fleet.yaml`); `fleetmind render` copies it into every per-agent workspace. Bots read it on session boot (after `SOUL.md` + `TOOLS.md`, before `memory/`). The per-bot-type `AGENTS.md` templates reference it in their startup-read list. Absent COMPANY.md is silently skipped. ([#156](https://github.com/Continuous-Agentics/fleetmind/pull/156))
- **Per-bot-type + per-agent GitHub App permission resolution.** `fleetmind github-app create` no longer hardcodes the permission scope. Each bot type ships an `openclaw/<bot-type>/github-app-permissions.yaml` declaring sensible defaults: PM bots are read-heavy, workers get the full code-contribution scope, backend additionally gets `deployments:write`. Per-agent `github_app.permissions` + `github_app.events` blocks in `fleet.yaml` override per-key (with `'none'` as an explicit drop). CLI logs the source breakdown (`N from manifest, M from override, K dropped`). Unknown permission keys (e.g. typos like `contens: write`) emit a warn-not-fail. ([#157](https://github.com/Continuous-Agentics/fleetmind/pull/157))

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
