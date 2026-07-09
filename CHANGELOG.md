# Changelog

All notable changes to fleetmind are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

## [0.9.0] — 2026-07-09

### Added

- **Worker Self-Start Protocol (CON-91, [#238](https://github.com/Continuous-Agentics/fleetmind/pull/238)).** Workers can now self-start on Linear-assigned issues without a PM delegation event. Introduces the `worker-self-start` skill; updates `bot-reception` and `bot-delegation` skills for the new entry point; enforces SF-2 create-before-notice ordering so the task record exists before any inbox notification is delivered.

### Fixed

- **`mergeTask` now gates on lifecycle to prevent requires-human-signoff bypass (MF-1, [#236](https://github.com/Continuous-Agentics/fleetmind/pull/236)).** A task with the `requires-human-signoff` lifecycle could previously be merged from the `shipped` state without passing through `signed_off`. `mergeTask` now validates the lifecycle before allowing the transition.

## [0.8.5] — 2026-06-20

### Fixed

- **`fleetmind secrets populate` now generates the gateway auth token.** The
  renderer emits `gateway.auth.token = ${<AGENT_UPPER>_GATEWAY_TOKEN}` and
  `fetch-agent-secrets` reads `<fleet>/agents/<agent>/gateway`, but `populate`
  never created that secret, so CLI-seeded or pre-bootstrap agents resolved the
  SecretRef to an empty value and the gateway refused to start with "Missing
  gateway auth token." `populate` now writes a per-agent `gateway` secret
  (`{ GATEWAY_TOKEN }`) in both interactive and non-interactive modes, mirroring
  the hooks-token path (single source of truth). New `gatewaySecretName` helper,
  `fleetmind secrets check` verifies the gateway secret, and the secret-names
  parity contract covers it. Companion `terraform-aws-fleetmind` change adds a
  managed `aws_secretsmanager_secret.gateway` and guards bootstrap STAGE 7b so it
  no longer overwrites a populate-seeded token on every reboot.
- **`fleetmind secrets populate` is now idempotent for auto-generated tokens.**
  Re-running `populate` no longer rotates the hooks/gateway tokens: it reads the
  existing secret and reuses a real (64-char hex) token, generating a fresh one
  only when the secret is absent or still holds the `PENDING_BOOTSTRAP`
  placeholder. This mirrors the terraform-aws-fleetmind bootstrap STAGE 7b guard,
  so all writers share one "don't clobber a live token" contract and re-running
  populate can't break a running gateway/TUI session. Use the new
  `--rotate-tokens` flag to deliberately force-roll these tokens.

## [0.8.4] — 2026-06-20

### Added

- **GitHub access is now required by default on every agent.** New per-agent
  `github_access` boolean (defaults to `true`) in `fleet.yaml`. Previously a bot
  only got a GitHub App if it declared a `github_app` block; now every agent is
  expected to have its own GitHub App unless it explicitly opts out with
  `github_access: false`. The `onboard` wizard's GitHub App steps (5 and 10) key
  off this flag: an agent with `github_access: false` is skipped, and the whole
  step is skipped only when every agent opts out. Permissions still resolve from
  the bot-type defaults (overridable via the per-agent `github_app` block) when
  access is required. Docs (`GITHUB-APPS.md`, `SETUP-A-FLEET.md`) updated.

## [0.8.3] — 2026-06-20

### Changed

- **`fleetmind onboard` secret steps: check first, then populate or ask.** Step 9
  (Slack + provider keys) and step 5 (GitHub App) now follow a consistent rule:
  if a secret is missing or a placeholder, it is populated automatically with no
  override question; if it is already populated, the wizard asks whether to
  update it and defaults to *no* (keep the existing value). This reverts the
  0.8.2 behavior where the override prompts defaulted to yes and an Enter-through
  re-run silently overwrote live secrets. Flow-advancement prompts ("Terraform
  apply complete?", "Populate secrets now?", "Run push fleet?", etc.) still
  default to yes; only the overwrite-existing-secret prompts default to no.

## [0.8.2] — 2026-06-20

### Changed

- **`fleetmind onboard` confirm prompts now default to yes consistently.** Every
  interactive confirm in the wizard now defaults to yes, so pressing Enter
  advances. Previously five prompts defaulted to no (`[y/N]`): "Terraform apply
  complete?", the three "Override existing secret?" prompts in step 9, and the
  step-5 "GitHub App already in SSM. Override?" prompt. They now default to yes
  (`[Y/n]`) like the rest of the wizard. Note: this means an Enter-through re-run
  will overwrite existing Slack tokens, provider API keys, and GitHub App
  credentials by default; answer `n` to keep an existing secret.

## [0.8.1] — 2026-06-20

### Changed

- **`fleetmind onboard` pre-flight now detects real completion of the
  AWS-touching steps.** Steps 6 (GitHub Packages PAT), 8 (Terraform apply), and
  9 (Populate secrets) were previously hardcoded to show `→` ("next") in the
  pre-flight summary regardless of actual state, so a re-run of a mostly-finished
  fleet looked like nothing was done. The summary now probes SSM + Secrets
  Manager: step 6 checks the shared PAT parameter, step 8 resolves every agent's
  EC2 instance via the `fleetmind:*` SSM tags, and step 9 confirms each agent has
  a non-placeholder Slack secret plus a real key for every declared provider.
  Any AWS error (offline, no creds) degrades to "next" (never a false "done").
- **GitHub Apps (steps 5 + 10) are now skipped when no agent declares a
  `github_app` block.** Fleets that don't need per-bot GitHub access are no
  longer prompted for a GitHub owner or per-agent app setup; the pre-flight shows
  these steps as `○` (n/a).
- **Step 7 render detection accepts `default.derived.tfvars`.** Single-fleet
  repos render to the `default` Terraform workspace; the pre-flight previously
  only looked for `<fleet>.derived.tfvars` and showed a false "next".

## [0.8.0] — 2026-06-20

First stable cut of the 0.8.0 line. Consolidates `0.8.0-beta.0` through
`0.8.0-beta.10` into a single supported release. Highlights below; see the
per-beta sections that follow for full detail.

### ⚠️ Breaking

- **fleet.yaml is v2; v1 files no longer load.** Top-level `targets:` map
  (hosts discriminated on `provider`: `aws-ssm | ssh | local`), per-agent
  `target:`, and a `channels:` list replacing the old `slack:` block. Existing
  v1 fleets must be migrated before upgrading. See `fleet.example.yaml` and the
  `fleetmind-template` repo for the v2 shape.
- **Per-provider Secrets Manager layout; combined `/model` secret removed.**
  `fleetmind secrets populate` writes one secret per `(agent, provider)` at
  `<fleet>/agents/<id>/providers/<provider>`. The earlier combined
  `<fleet>/agents/<id>/model` secret is gone. Lockstep with
  `terraform-aws-fleetmind` ≥ v1.0.0 via `src/core/secret-names.ts` (TS) and
  `modules/agent/main.tf` locals (TF).
- **`providers:` is now required on every agent in `fleet.yaml`.** Provider
  inference from the `model:` string is removed; each agent must declare its
  providers explicitly.

### Added

- **NATS delegation transport.** Inter-bot delegation runs over a NATS bus with
  per-agent `fleetmind-nats-<agent>.service` subscribers (path-activated on
  `fleet.yaml`). Auto-defaults `nats: {}` when `delegation.enabled` is true.
  The EventBridge/SSM wake pipeline is retired in favor of NATS push +
  `POST /hooks/wake`.
- **`fleetmind up`** — bring a fleet up on the local machine with no cloud
  (agents sharing a `local` target run in one OpenClaw gateway).
- **`fleetmind secrets check`** — read-only present/absent report per
  `(agent, provider)`, counterpart to `secrets populate`.
- **`fleetmind onboard`** — interactive bring-up wizard with an `OnboardDeps`
  injection seam and full integration-test coverage.
- **Multi-provider models + `fallback_models`** — `model` is a
  `provider/model` string; per-agent or fleet-wide failover chain.

### Fixed

- Timeouts added to clawhub `execSync` calls; `self-upgrade` and skill-resolver
  hang fixes; clearer `ResourceNotFoundException` messaging in
  `secrets populate`.


## [0.8.0-beta.10] — 2026-06-08

### Added

- **`OnboardDeps` injection seam for `runOnboard`** — Introduces an `OnboardDeps`
  interface and a `createDefaultDeps(region?)` factory that bundles the wizard's
  external dependencies (AWS `SecretsManagerClient` + `SSMClient`, file-system
  ops, terminal prompter, `pushFleet` / `provisionFleet` / `writeOutputs`).
  `runOnboard` now accepts an optional fourth argument `deps: OnboardDeps =
  createDefaultDeps(region)`. Production callers that omit `deps` observe
  byte-identical behavior — this is a non-breaking, additive change.
  ([#216](https://github.com/Continuous-Agentics/fleetmind/issues/216))

- **`src/test/cli-onboard.test.ts`** — Integration test suite for the onboard
  wizard. Uses the `OnboardDeps` seam to drive all 12 steps with mocked AWS
  clients and a queue-based mock prompter. Covers: happy paths (delegation
  enabled/disabled), step-9 provider-prompt matrix (openai-only, multi-provider,
  existing-secret override, missing-providers error), idempotency (step-3 skip,
  step-5 already-in-SSM, partial-step-9 re-prompt), and fallback paths
  (--legacy-github-apps, empty-owner fallback to legacy mode).
- **`fleetmind secrets check`** — read-only counterpart to `secrets populate`.
  `DescribeSecret`s every name `populate` would target and prints a
  present/absent report per `(agent, provider)` so naming drift between
  the CLI and the applied Terraform module is visible without mutating
  anything.
- **`src/core/secret-names.ts`** — single TS source of truth for Secrets
  Manager naming (`slackSecretName`, `hooksSecretName`,
  `providerSecretName`, `agentSecretPrefix`). The matching Terraform helper
  lives in `terraform-aws-fleetmind` `modules/agent/main.tf` `locals`; both
  sides include a parity comment pointing at the other.
- **Strict-providers errors.** Missing/empty `providers:` raises a clear
  message naming the agent and pointing at `fleet.yaml`.

### ⚠️ Breaking

- **Per-provider Secrets Manager layout; combined `/model` secret removed.**
  `fleetmind secrets populate` now writes one secret per `(agent, provider)`
  pair at `<fleet>/agents/<id>/providers/<provider>` (each holding a single
  `{"<PROVIDER>_API_KEY": "..."}` JSON object). The previous combined
  `<fleet>/agents/<id>/model` secret is no longer written or read. This
  matches the canonical layout shared with `terraform-aws-fleetmind` v0.5.0
  via `src/core/secret-names.ts` (TS) and `modules/agent/main.tf` locals
  (TF) — they MUST stay in lockstep.
- **`providers:` is now required on every agent in `fleet.yaml`.** Provider
  inference from the `model:` string has been removed. Each agent must
  declare its providers explicitly:
  ```yaml
  agents:
    list:
      - id: ranger
        model: anthropic/claude-sonnet-4-6
        providers:
          - anthropic
  ```
  Multi-provider agents list every provider they use
  (`providers: [anthropic, openai]`). Missing or empty `providers:` raises a clear error pointing at the agent id.
- **Migration from a fleet on the old `/model` shape:**
  1. Upgrade `terraform-aws-fleetmind` to `v0.5.0`, bump your
     `fleetmind-template` ref, and add `providers:` to every agent in
     `fleet.yaml`.
  2. Delete the stale combined secrets (one per agent) so the new per-provider
     resources can be created on the same name:
     ```bash
     aws secretsmanager delete-secret \
       --secret-id "<fleet>/agents/<id>/model" \
       --force-delete-without-recovery --region <region>
     ```
  3. `terraform apply` to create the new `providers/<provider>` secrets.
  4. `fleetmind secrets populate` (or `--interactive`) to push API keys.
  5. `fleetmind secrets check` to confirm every expected secret exists.

### Changed

- **`fleetmind onboard`** uses the same per-provider fan-out as
  `secrets populate`; the interactive path writes one secret per provider.
- **`ResourceNotFoundException` reporting** in `secrets populate` now hints
  at the module-version mismatch when a `providers/<provider>` secret is
  missing ("terraform-aws-fleetmind must be at >= v0.5.0 and applied").

### Fixed

- **`fleetmind self-upgrade` and skill-resolver hangs.** Added explicit
  timeouts to `clawhub -V` (10s) and `clawhub install ...` (120s)
  `execSync` calls in `src/runtime/resolver.ts`. A misbehaving or absent
  `clawhub` binary no longer freezes the resolver indefinitely; it now
  fails fast with a clear error message.
  ([#172](https://github.com/Continuous-Agentics/fleetmind/pull/172))
- **DI seam closure for GitHub App helpers** —
  `createGithubApp` and `storeGithubApp` now accept an injected `ssmClient`
  parameter. Both helpers previously instantiated their own `SSMClient`
  inline, which bypassed the `OnboardDeps` seam and could trigger real
  AWS calls in tests using mocked deps. Production callers continue to
  omit the parameter (default behavior unchanged).
  ([#218](https://github.com/Continuous-Agentics/fleetmind/pull/218))

### Internal

- **Test scaffolding hardening.** `cli-onboard.test.ts` `tmpDir` cleanup
  guards against undefined assignment (no longer masks real test failures
  when setup throws). Dead-variable cleanup in `onboard.ts`
  (`derivedTfvarsPath`, Step-11 `reloadedFleet`). Consistent `??` fallback
  pattern for optional deps.
  ([#218](https://github.com/Continuous-Agentics/fleetmind/pull/218))

## [0.8.0-beta.9] — 2026-06-03

### Changed

- **`fleetmind secrets populate`: clearer `ResourceNotFoundException` errors.**
  When AWS Secrets Manager returns "can't find the specified secret",
  the CLI now reports the missing secret name, the AWS account id (looked
  up lazily via STS `GetCallerIdentity`), and the region from the client
  config so the user can immediately see *which* AWS identity is missing
  the secret. Falls back gracefully (`account <unable to determine — STS
  GetCallerIdentity failed: ...>`) if STS can't resolve caller identity.
  (#209)

### Removed

- **`delegation.sweeps` schema field + `WORKER_SWEEP` cron-seeding pipeline.**
  Sweeps were the pre-NATS polling backstop: PM bots seeded an
  `~/.openclaw/cron/jobs.json` entry per worker that fired an isolated Haiku
  turn every N minutes asking "anything stuck with `<worker>`?" The NATS
  subscriber (live since 0.8.0-beta.x) is the canonical wake path now —
  workers publish `task.shipped` / `task.blocked` on close, which wakes the
  PM on the delegation thread directly. The sweep was redundant on every
  happy path and contradicted the bot-delegation skill's own guidance
  ("This subscriber replaces sweep cron jobs"). What this removes:
  - `CronSweepSchema`, `CronSweepConfig` type, and `sweeps:` field on
    `DelegationAgentSchema` in [src/config/schema.ts](src/config/schema.ts).
    Fleets that still declare `delegation.sweeps:` will fail Zod validation.
  - `seedCronSweeps`, `sweepJobId`, `buildSweepJob`, and the `CronJob` /
    `CronJobsFile` interfaces in
    [src/runtime/provisioner.ts](src/runtime/provisioner.ts) (plus the
    diff-reporter branch that surfaced "[+] seed cron sweep" lines).
  - The orchestrator-only `cron/jobs.json` shipping branch in
    [src/cli/commands/push-fleet.ts](src/cli/commands/push-fleet.ts).
  - `src/test/cron-sweeps.test.ts` (deleted) and the sweep-seeding test in
    [src/test/provisioner-deploy-path.test.ts](src/test/provisioner-deploy-path.test.ts).

  pm-bot AGENTS.md, bot-delegation SKILL.md, the `fleet.example.yaml`
  example block, [docs/integration/delegation.md](docs/integration/delegation.md),
  and [docs/test/gg-sandbox/RUNBOOK.md](docs/test/gg-sandbox/RUNBOOK.md)
  all updated to reflect NATS-wake as the close-the-loop path. The
  "defer close-the-loop to the next sweep sub-agent" rule was removed from
  the PM's Hard Limits — PMs now close the loop directly on the NATS-wake
  turn.

  **Migration for existing fleets with seeded sweeps:** the schema removal
  stops new seeding, but `fleetmind deploy` was never wired to *remove*
  jobs from a remote `jobs.json`. Operators with legacy `forge-sweep`-style
  jobs running on their PM instances should clean up once:

  ```bash
  # SSH to each PM instance
  openclaw cron list          # find the WORKER_SWEEP job(s)
  openclaw cron rm <job-id>   # remove each one
  ```

### Added

- **Worker → home-channel routing for inbound delegations.** Workers no
  longer post their picked-up announcement into the PM's delegation
  thread; they break out into THEIR OWN home channel (the first channel
  listed under that agent's `channels:` block in `fleet.yaml`) and open
  a fresh thread there. Matches the "PM in central channel, workers in
  their own channels" team-shape model (e.g. PM in `#general`, Forge in
  `#development`).

  Three layers changed together:
  - **Subscriber** (`src/cli/commands/nats.ts`): new
    `resolveWorkerHomeChannel(fleet, workerId)` looks up the worker's
    home channel from fleet.yaml; new `postSlackChannelMessage` posts a
    top-level message to a channel and returns the resulting ts. Worker
    handler now posts the fast-path ack to the home channel (instead of
    `delegation_thread`), captures the returned ts, and uses it as the
    session-key thread root for `wakeAgent`.
  - **Renderer** (`src/runtime/renderer.ts`): per-agent fleet.yaml slice
    (`renderAgentFleetYaml`) now includes the agent's `channels:` block
    so the on-bot subscriber can resolve the home channel. Previously
    stripped, which is why the subscriber would silently fall back to
    delegation_thread posting (the home channel was invisible to it).
  - **`bot-reception` skill (v1.3.0 → v1.4.0):** step 4 prose rewritten
    to be explicit that the picked-up announcement goes in the agent's
    OWN home channel — never in the PM's delegation thread. The
    `delegation_thread` URL is included as a back-link inside the
    announcement so humans can trace which conversation triggered the
    work. Companion subscriber-side ack creates the thread root; the
    skill's announcement is the first considered reply.

  Fall-back: workers with no `channels:` block in fleet.yaml continue
  to post in `delegation_thread` exactly like beta.6 — same behavior
  for non-Slack / minimally-configured fleets.

- **Fast-path Slack ack on WORKER delegation receipt.** Symmetric to the
  PM-side fast-path (also in this section). The worker subscriber now
  posts a one-line `👋 Received delegation <task> from <pm> — picking up.
  Details coming.` directly to the delegation Slack thread the moment
  the NATS delegation event arrives — BEFORE wakeAgent dispatches the
  considered bot-reception turn (which can take 10–30s+ to boot the
  session, read the skill, and run the full step-4 announcement).
  Closes the gap where the human pings the PM, the PM delegates over
  NATS, and there's a multi-second silence before the worker's
  considered "@requestor — picked up" message arrives. With this, the
  human sees the worker acknowledge receipt instantly, then the formal
  picked-up announcement follows when the LLM is ready. Worker's own
  bot token is used (so the post appears as the worker, not the PM).
- **Fast-path Slack ack on PM ship/block.** The PM subscriber now posts a
  one-line `✓ Received ship for <task> from <worker> — reviewing` directly
  to the delegation Slack thread via Slack's `chat.postMessage` API the
  moment a NATS ship/block event arrives — BEFORE dispatching the
  considered agent-turn response. New `postSlackThreadAck()` helper. Two
  surfaces now: instant "I heard you" (~300ms via Slack API; no LLM, no
  session lock) and considered "I have an opinion" (the wakeAgent turn,
  which still legitimately takes 30s–3min). Without this, observed
  human-visible delay was 28–48 minutes between a worker shipping and the
  human seeing Conductor acknowledge anything — turns were correctly
  routed (per the beta.4 fix) but serialized on the same Slack-thread
  session and queued behind prior work. Tolerant of missing pieces
  (`SLACK_BOT_TOKEN` absent → skip the ack but still fire the wake;
  `delegation_thread` empty → skip both). Fire-and-forget — never blocks
  the subscriber.

### Fixed

- **Worker-side `wakeAgent` now routes inbound delegations into the live
  Slack-thread session, not `:main`.** Same pattern as the PM-side fix
  shipped in 0.8.0-beta.4: parse `event.delegation_thread` → build the
  `agent:<worker>:slack:channel:<chan-lowercased>:thread:<dotted-ts>`
  session key → pass via `openclaw agent --session-key`. Without this,
  worker turns ran in `:main`, and when bot-reception's "@requestor —
  picked up" announcement fired, the LLM picked a default reply target
  (often a DM with the requestor) instead of the original delegation
  thread. Each delegation routes per-task based on its own
  `delegation_thread`; tasks with empty `delegation_thread` (non-Slack
  delegations, very old records pre-thread-population) fall back to
  `:main` exactly like today.

### Changed

- **`bot-reception` skill (v1.2.0 → v1.3.0):** Slack-first ordering is
  now mandatory and explicit, not implicit. The "open Slack thread"
  step (#4) is framed as the first thing the human sees and as a
  precondition to any task work. Previously the LLM would parallelize
  the Slack post with the actual work, which meant the human-visible
  "@picked up" message often arrived *after* the work was done (or
  never, if the agent timed out mid-work). Added a "stop and post
  first" rule the LLM can check against before any work-side tool
  call.

## [0.8.0-dev] — 2026-05-27 (superseded by 0.8.0)

Provider-neutral release: AWS/Slack become **one backend among several**. The
fleet config moves to a v2 schema and the deploy layer is abstracted behind
provider interfaces, adding a no-cloud local path (`fleetmind up`) alongside the
existing AWS/EC2 flow.

### ⚠️ Breaking

- **fleet.yaml is now v2 and v1 files no longer load.** Clean break, no compat
  shim. Migration:
  - Add a top-level `targets:` map (hosts, discriminated on `provider`:
    `aws-ssm | ssh | local`; each carries `os` / `service_manager` /
    `workspace_base`). Point each agent at one via `target:` (or
    `agents.defaults.target`).
  - Move `workspace_base` off `agents.defaults` onto the target(s).
  - Replace each agent's `slack:` block with a `channels:` entry
    (`- provider: slack`, …).
  - Replace `agent.anthropic.api_key` with `agent.api_keys` (a provider→key
    map). Model API keys are now keyed by provider.
  See `fleet.example.yaml` and the `fleetmind-template` repo for the v2 shape.
  Existing v1 fleets must be migrated before upgrading.

### Added

- **`fleetmind up`** — bring a fleet up on the local machine with no cloud.
  Agents that share a `local` target run in **one** OpenClaw gateway (OpenClaw's
  native multi-agent model — each agent keeps its own workspace, skills, Slack
  app, model, and persona). Renders the host's `~/.openclaw/openclaw.json`,
  writes resolved secrets to `~/.openclaw/.env` (chmod 600; secrets stay as
  `${VAR}` in the config), provisions each agent's workspace, then delegates the
  daemon to `openclaw onboard --install-daemon`. `--no-daemon` / `--dry-run`.
- **Multi-provider models.** `model` is a `provider/model` string (OpenClaw
  makes the call); `api_keys` maps providers to credentials. `secrets populate`
  writes a single combined `<fleet>/agents/<id>/model` secret holding every
  `<PROVIDER>_API_KEY` the agent uses (ANTHROPIC_API_KEY, OPENAI_API_KEY, …), so
  any provider mix works without per-provider secrets/IAM/fetch. (Requires the
  matching `terraform-aws-fleetmind` release that creates + fetches `/model`.)
  For `openai/*` models the renderer emits `agentRuntime: { id: "openclaw" }`
  (OpenClaw otherwise routes `openai/*` to the Codex subscription harness), so
  the injected `OPENAI_API_KEY` is used.
- **Fallback models.** `fallback_models` on an agent (or `agents.defaults`)
  renders to OpenClaw's `model.fallbacks` failover chain (`[]` = strict).
- **Targets + deploy transport.** Provider interfaces (`ArtifactStore`,
  `TargetResolver`, `CommandRunner`, `ServiceManager`) with AWS (S3 + SSM) and
  local (filesystem + launchd) adapters behind a provider factory. Optional
  `deploy.artifact_store` (`s3 | local-fs | scp`).
- Per-target rendering: one gateway config per host (AWS one-agent-per-host is
  the n=1 case; a local box hosts all its agents in one gateway).

### Changed

- Branded, validated identifiers (fleet/agent/target/skill names, NATS subject
  prefix, workspace base) — anything that survives config parsing is safe to
  interpolate into paths, shell, S3 keys, systemd units, env vars, and NATS
  subjects. Cross-references (agent→target, channels) are resolved after parse
  and fail loud at load time.
- `push fleet` / `pull-self` are provider-aware (AWS behavior preserved); the
  on-host model is "smart host, thin command" (the host runs `fleetmind
  pull-self`).

### Fixed

- `fleetmind init` scaffolded an unloadable (v1) `fleet.yaml`; it now emits v2.
- `fleetmind onboard` wrote Slack channel IDs via a v1-shaped regex that
  couldn't match the v2 `channels` layout; rewritten via the YAML document API.
  Also fixed `secrets populate` still reading the removed `agent.slack` block.
- **`delegation.nats` is auto-defaulted when delegation is enabled.** Fleets
  with `delegation.enabled: true` but no `nats:` block previously deployed
  cleanly and silently no-op'd — the subscriber unit started, saw no `nats:`
  block, and exited cleanly. NATS is the only supported delegation transport
  today, so `enabled` without `nats` was never a valid runtime state. The
  normalizer now fills in `nats: {}` so the schema defaults + renderer's
  Cloud-Map URL derivation (`nats://nats.<fleet>.internal:4222`) take over
  without the operator having to write the literal line. Explicit `nats:`
  blocks are unchanged.
- **`wakeAgent` actually wakes the OpenClaw agent now.** The NATS subscriber's
  wake path (`src/cli/commands/nats.ts`) was POSTing
  `{action: "create_flow", goal: <msg>}` to the gateway's
  `/plugins/webhooks/nats-wake` route. The gateway happily accepted (HTTP 200,
  real `flowId` returned) — but flows from that route just sat in
  `.openclaw/flows/registry.sqlite` with `status: queued` and were never
  drained by the agent's main loop. Result: subscriber ack'd DDB
  (`delegated → accepted`) but the worker never processed the task, never
  opened a Slack thread per the bot-reception protocol, and never published a
  `ship` event back to NATS. The whole delegation primitive was broken
  end-to-end. Replaced with `openclaw agent --agent <id> --message <msg>` (the
  OpenClaw CLI "run one agent turn" primitive), which is what the bot-reception
  protocol's wake path actually wants. The fallback CLI path in the original
  code already used the same primitive — it just never ran because
  `OPENCLAW_HOOKS_TOKEN` was set, gating it behind the broken webhook path.
  Verified live: a delegation event now triggers a real agent turn (`status:
  ok`, model call to `claude-sonnet-4-6`, response payload). Per-agent model
  overrides also confirmed working (the `agent model: ...haiku...` line in
  gateway startup logs is just the default being announced before per-turn
  resolution — not a misconfig).
- **PM-side wakes now land in the correct Slack-thread session, not `:main`.**
  When a worker published a `ship`/`block` event, the PM's NATS subscriber
  received it and called `wakeAgent("conductor", msg)` — but without a session
  key, the resulting agent turn ran in `agent:<pm>:main`, invisible to whatever
  Slack thread the PM was actively chatting in. So Conductor (in Slack) would
  confidently report *"the NATS event never made it"* even though the journal
  showed the subscriber receiving it cleanly. Fix: `wakeAgent` now takes an
  optional `sessionKey` arg, and the PM-mode handler derives one from the
  task's `delegation_thread` URL (via the new `parseSlackThreadUrl` +
  `slackThreadSessionKey` helpers). The OpenClaw CLI's `--session-key` routes
  the turn into the live thread session
  (`agent:<pm>:slack:channel:<channel-lowercased>:thread:<dotted-ts>`),
  whose `route.thread.id` carries the agent's reply back into the same Slack
  thread the human is watching. Multi-session safe: each ship event routes
  per-task based on its own `delegation_thread`. Verified live by publishing
  a manual ship event and observing Conductor post in the original delegation
  thread (not in `:main`). The same routing pattern would extend to the worker
  side when workers start holding multiple parallel Slack-thread sessions.
- **wakeAgent timeouts are no longer the bottleneck.** Two layered timeouts
  now match: the openclaw CLI's `--timeout` is explicitly set to 10min, and
  the wrapping `execFile` timeout is 10min + 30s slack. The old 60s `execFile`
  timeout was SIGTERM-ing the CLI mid-turn, causing the gateway to abort the
  in-flight LLM call and emit a misleading
  *"LLM request timed out — increase agents.defaults.timeoutSeconds"* (the LLM
  call wasn't the thing timing out; the subscriber-side wrapper was). Symptom:
  every NATS-driven turn that involved real external tool use died at ~52–60s
  no matter what `agents.defaults.timeoutSeconds` was set to.
- **`agents.defaults.timeoutSeconds` is now configurable from fleet.yaml.**
  New `agents.defaults.timeout_seconds` field on `AgentDefaultsSchema`,
  defaults to 300s, renders to `agents.defaults.timeoutSeconds` in
  `openclaw.json`. OpenClaw's built-in default (~60s) is too tight for the
  typical bot-reception turn (Slack post + external tool calls + write the
  artifact + post completion). The 300s default unblocks first-turn
  exploratory work; operators can bump higher for heavier workflows.

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
