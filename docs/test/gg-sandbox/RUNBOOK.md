# FleetMind Test Deploy Runbook
**Branch:** `test/gg-sandbox` · **Target account:** `251714435910` (gg-sandbox) · **Region:** `us-west-2`  
**Fleet:** 1 PM (Conductor 🎼) + 1 worker (Forge ⚙️)  
**Last updated:** 2026-05-12

---

## Context

FleetMind provisions a fleet of isolated OpenClaw agents — one EC2 instance, one gateway process, one Slack app, and one workspace per agent. A single `fleet.yaml` is the source of truth. `fleetmind render`/`deploy` generates per-agent `openclaw.json` configs and workspace files; Terraform provisions the EC2 infrastructure; AWS Secrets Manager holds runtime credentials.

This runbook covers the full end-to-end deployment: Terraform infra → secrets → workspace render → EC2 transport → gateway start → smoke test.

---

## Known Issues & Status (as of branch head)

| ID | Issue | Status |
|----|-------|--------|
| AMI filter caught minimal AMI | PR #40 fixed: filter now `al2023-ami-2023*-x86_64` | ✅ Fixed |
| SSM agent missing from minimal AMI | PR #40 fixed: bootstrap installs `amazon-ssm-agent` in STAGE 2c | ✅ Fixed |
| `systemctl start` in bootstrap killed cloud-init | PR #37 fixed: bootstrap only `enable`s the unit; start is manual | ✅ Fixed |
| `ExecStart` used wrong command (`openclaw start`) | PR #37 fixed: now `openclaw gateway` | ✅ Fixed |
| Bootstrap output not visible in console | PR #36 fixed: mirrored to `/dev/console` | ✅ Fixed |
| `renderTerraformVars()` output wrong var names | PR #23 fixed: `agent_names`, `agent_models` | ✅ Fixed |
| Task-ledger module not wired into root TF | PR #23 fixed: `count`-gated `module.task_ledger` | ✅ Fixed |
| Workspace path prefix `workspace-` mismatch | PR #32 fixed: renderer uses plain `<agent_id>` on EC2 side | ✅ Fixed |
| Agents on public subnets | PR #35 fixed: private subnets, no public IPs | ✅ Fixed |
| EBS workspace volumes (unnecessary) | PR #34 removed: workspaces live on root EBS | ✅ Fixed |
| VPC endpoints for SSM/SecretsManager | PR #40 added: interface endpoints opt-in via `enable_interface_endpoints` | ✅ Added |
| `fleetmind deploy` EACCES on local render | PR #32 fixed: renders to `./rendered/workspaces/<id>/` | ✅ Fixed |
| No automated deploy transport (S3/SSM push) | `fleetmind push fleet` + `pull-self` (this PR) | ✅ Shipped |
| Fleet Members table in AGENTS.md | Issue #20 — quality gap, not blocking | 🟡 Open |
| `wake_target_session_key` no validation block | TF smell, not blocking | 🟡 Open |
| DynamoDB context-store name `fleetmind-fleetmind` | TF smell with default fleet_name | 🟡 Open |

**TF validate status:** ✅ Clean on both `infra/terraform/` and `modules/task-ledger/`  
**Test suite:** ✅ 91/91 passing

---

## What We Learned From the First Deploy (PR #47)

Five bootstrap/renderer bugs surfaced during the first live deploy attempt. All fixed in one PR (`fix/gg-sandbox-deploy-followups`, PR #47 against `test/gg-sandbox`):

1. **`EnvironmentFile=` needs `-` prefix** — without it, systemd fails at unit-load time if `/run/openclaw-<agent>.env` doesn't yet exist (fresh tmpfs). Added `-` so a missing file is silently tolerated until `ExecStartPre` creates it.
2. **`ExecStartPre=` needs `+` prefix** — the unit runs as `ec2-user`, but `/run` is `root:root 755`. `fetch-agent-secrets` uses `install -m 600` which requires root. Added `+` so `ExecStartPre` runs as root regardless of `User=`.
3. **`HOME=` must point at the per-agent workspace** — OpenClaw reads `$HOME/.openclaw/openclaw.json`. Pointing `HOME` at `/home/ec2-user` caused a "config not found" failure; changed to `$WORKSPACE_DIR`.
4. **`fetch-agent-secrets` must emit per-agent alias keys** — `fleet.yaml` references tokens as `${CONDUCTOR_BOT_TOKEN}` etc., but the script was only emitting bare keys (`SLACK_BOT_TOKEN`). The Python emit loop now also writes `<AGENT>_<KEY>=<value>` aliases for every secret, so both naming conventions resolve.
5. **Renderer emitted `a2aAllow` as objects; OpenClaw expects string array** — `tools.agentToAgent.allow` must be `["forge"]`, not `[{from:"conductor",to:"forge"}]`. Fixed in `renderAgentOpenClawJson` (and the deprecated `renderOpenClawJson` for symmetry).

---

## Prerequisites

### Operator machine
- `terraform` ≥ 1.6 (or use `tfenv` — `.terraform-version` is committed)
- `aws` CLI v2 configured with access to gg-sandbox (`251714435910`)
- `node` ≥ 20, `npm` ≥ 10
- `fleetmind` CLI: `npm install -g @continuous-agentics/fleetmind` (see npm auth setup below)
- SSH key with access to EC2 (if using SCP transport — see Step 5)

### Configure npm for GitHub Packages (one-time)

fleetmind is now published as a **private scoped package** on GitHub Packages, not public npm.
You need a GitHub PAT with `read:packages` scope to install it:

```bash
# 1. Generate a classic PAT at https://github.com/settings/tokens
#    Required scopes: read:packages (write:packages if you'll publish)

# 2. Add to your ~/.npmrc:
echo "@continuous-agentics:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=<YOUR_PAT>" >> ~/.npmrc

# 3. Now install:
npm install -g @continuous-agentics/fleetmind
```

See `RELEASING.md` for the full release process and SSM token setup for EC2 instances.

### AWS identity
Use `AdministratorAccess` on the deploying identity for a test run. Enumerate least-privilege post-validation. The principal needs EC2, VPC, IAM, Secrets Manager, DynamoDB, S3, EventBridge, SQS, SNS, SSM, and CloudWatch permissions. See the Pre-Flight Assessment for the full permission list.

### Slack apps
Two Slack apps are required — one per agent. Create them in your test workspace before proceeding.

**Generate the manifests** (run from the repo root after `npm install`):
```bash
fleetmind slack manifests --out docs/test/gg-sandbox/slack-manifests/
```
This writes one `<agent_id>.yaml` per agent (e.g. `conductor.yaml`, `forge.yaml`). Upload each YAML into the Slack app-create wizard (`https://api.slack.com/apps → Create New App → From a manifest`).

The generated manifests include the full scope + event set verified to work with the live gg-sandbox bots. Committed reference copies live in `docs/test/gg-sandbox/slack-manifests/` and can be re-generated at any time from `fleet.yaml`.

After creating each app, collect and export to your shell:
```bash
export CONDUCTOR_BOT_TOKEN="xoxb-..."
export CONDUCTOR_APP_TOKEN="xapp-..."
export FORGE_BOT_TOKEN="xoxb-..."
export FORGE_APP_TOKEN="xapp-..."
export ANTHROPIC_API_KEY="sk-ant-..."   # used for both agents in this test fleet

> **Note:** `signing_secret` is not needed for socket-mode setups (what fleetmind uses).
> It is only required for HTTP request-mode Slack apps. Do not export it.
```

> **These env vars must be set for the entire session.** The `fleetmind render` step bakes them into `openclaw.json` at render time (see Step 5). They're also needed for `fleetmind secrets populate` (Step 4).

---

## Step 1: Clone & Install

> **Reminder:** Before `terraform apply`, `@continuous-agentics/fleetmind` must be
> published to GitHub Packages at the version pinned in `terraform-extras.tfvars`
> (`fleetmind_version`). If the package isn't published yet, STAGE 6b of the bootstrap
> will fail on every instance. See `RELEASING.md` → "Post-merge order for PR #59".

```bash
git clone -b test/gg-sandbox https://github.com/Continuous-Agentics/fleetmind.git
cd fleetmind
npm install
npm run build          # confirm: 0 errors
npm test               # confirm: 199 pass
```

The working `fleet.yaml` for this deploy is in the repo root. Review it before proceeding — it references the gg-sandbox account, us-west-2 region, and the gg-sandbox Slack workspace.

---

## Step 2: Terraform — Core Infrastructure

### 2a. Initialize

```bash
cd infra/terraform
terraform init
```

> Backend is local by default (no remote state). For anything beyond a throwaway test, create an S3 bucket + DynamoDB lock table and uncomment the `backend "s3"` block in `main.tf` before running `init`.

### 2b. Review the tfvars

The file `infra/terraform/terraform-extras.tfvars` contains the gg-sandbox-specific overrides (already committed in the repo):

```hcl
aws_region                = "us-west-2"
fleet_name                = "gg-sandbox"
agent_names               = ["conductor", "forge"]
enable_interface_endpoints = true    # SSM + SecretsManager + ec2messages endpoints
delegation_enabled         = true
wake_target_session_key    = "REPLACE_ME"   # see note below
```

**Set `wake_target_session_key` before applying.** This is the SSM session parameter key that EventBridge uses to wake Conductor when Forge ships a delegated task. Set it to a meaningful string (e.g., `"gg-sandbox-conductor-wake"`). There is no Terraform validation that catches an empty string when `delegation_enabled = true` — a blank value silently breaks the wake pipeline.

Edit `terraform-extras.tfvars`:
```hcl
wake_target_session_key = "gg-sandbox-conductor-wake"
```

### 2c. Plan & Apply — root module

```bash
terraform plan -var-file=terraform-extras.tfvars -out=tfplan
terraform apply tfplan
```

Resources created (~25 total):
- VPC, 2 public subnets, 2 private subnets, IGW, NAT Gateway, route tables
- VPC endpoints: S3 (gateway), DynamoDB (gateway), SSM, ssmmessages, ec2messages, SecretsManager (interface)
- 2 EC2 instances (conductor + forge) in private subnets — **no public IPs**
- Per-agent IAM roles + instance profiles
- Per-agent Secrets Manager placeholders (6 total: 2 slack + 2 anthropic... wait — 1 slack + 1 anthropic per agent = 4 total)
- DynamoDB context-store table (`gg-sandbox-context-store`)
- Module: task-ledger DynamoDB table, S3 narratives bucket, EventBridge Pipe, SQS DLQ, CloudWatch alarm

**Capture outputs** — you'll need them in later steps:
```bash
terraform output -json > /tmp/fleetmind-tf-outputs.json
cat /tmp/fleetmind-tf-outputs.json
```

Key outputs to note:
- `private_ips` — IP addresses for each agent's EC2 (used for SCP transport)
- `ssm_connect` — pre-built SSM start-session commands for each agent
- `instance_ids` — EC2 instance IDs
- `secrets_arns` — ARNs of the per-agent Secrets Manager secrets

### 2d. Wait for EC2 bootstrap to complete

The instances run a 13-stage bootstrap script during user_data. Watch for completion:

```bash
# Via EC2 console output (most reliable — the script writes to /dev/console)
CONDUCTOR_ID=$(terraform output -json instance_ids | jq -r '.conductor')
aws ec2 get-console-output --instance-id $CONDUCTOR_ID --region us-west-2 \
  --query 'Output' --output text | tail -50
```

All 13 stages should complete. Specifically look for:
```
[bootstrap] STAGE 2c: amazon-ssm-agent install/start at ...
[bootstrap] amazon-ssm-agent: active
[bootstrap] Done. Agent conductor provisioned (fleet: gg-sandbox) — gateway will start on next boot or manual start
```

If you see `amazon-ssm-agent: inactive` in STAGE 13 output: the instance is running the bootstrap but SSM agent failed to start (likely a transient dnf issue). SSH in via the bastion or wait for the next boot cycle.

### 2e. Verify SSM registration

After bootstrap completes (allow 3–5 min from instance launch), both instances should appear in SSM:

```bash
aws ssm describe-instance-information --region us-west-2 \
  --filters Key=tag:fleet_name,Values=gg-sandbox \
  --query 'InstanceInformationList[*].{ID:InstanceId,Ping:PingStatus,Platform:PlatformName}' \
  --output table
```

Expected: both conductor and forge with `PingStatus: Online`.

If instances don't appear after 10 minutes, check:
1. EC2 console output (STAGE 2c) — was SSM agent installed and enabled?
2. IAM: `AmazonSSMManagedInstanceCore` is attached to the instance role (verify in IAM console)
3. Network: NAT gateway is in `available` state, private subnet route table has `0.0.0.0/0 → nat-...`
4. VPC endpoints: `aws ec2 describe-vpc-endpoints --region us-west-2` — SSM/ssmmessages/ec2messages should be `available`

---

## Step 3: Terraform — Task-Ledger Module

The task-ledger module is **not** auto-applied by the root module (it's a separate Terraform root at `infra/terraform/modules/task-ledger/`). Apply it separately, passing the agent role names from the root apply:

```bash
# Capture role names from root outputs
CONDUCTOR_ROLE=$(terraform output -json | jq -r '.agent_role_names.value.conductor')
FORGE_ROLE=$(terraform output -json | jq -r '.agent_role_names.value.forge')

cd ../modules/task-ledger
terraform init

terraform apply \
  -var="fleet_name=gg-sandbox" \
  -var="aws_region=us-west-2" \
  -var="table_name=gg-sandbox-tasks" \
  -var="s3_bucket=gg-sandbox-narratives-251714435910" \
  -var="pm_role_names=[\"$CONDUCTOR_ROLE\"]" \
  -var="worker_role_names=[\"$FORGE_ROLE\"]"

cd ../../   # back to infra/terraform root
```

> **Why separate?** The task-ledger module needs the agent role names as inputs, which are outputs of the root apply. Wiring it as a child module creates a chicken-and-egg dependency. The current design applies it as a second root with explicit role name inputs.

> **Deprecation warnings during init:** `hash_key` is deprecated in AWS provider 6.x. These warnings only fire when the module is initialized standalone (picks up provider 6.x). During actual apply, the root module's locked provider 5.100.0 is used — no warnings, no impact.

---

## Step 4: Populate Secrets

**Ensure your shell has all six token env vars set** (from the Prerequisites section) before running these commands.

### 4a. Via `fleetmind secrets populate` (recommended)

```bash
cd /path/to/fleetmind   # repo root

# Push all agent secrets interactively, resolving from your shell env
fleetmind secrets populate --interactive --region us-west-2
```

The `populate` command reads `fleet.yaml`, identifies the `${VAR}` placeholders in each agent's `slack.bot_token` and `app_token` fields, resolves them from your environment, and pushes them to Secrets Manager using the standard key names (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`).

> **Note:** `signing_secret` / `SLACK_SIGNING_SECRET` is **not** required for socket-mode bots and is not prompted for or stored.

For the Anthropic key (one per agent in this fleet):
```bash
aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id "gg-sandbox/agents/conductor/anthropic" \
  --secret-string "{\"ANTHROPIC_API_KEY\":\"$ANTHROPIC_API_KEY\"}"

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id "gg-sandbox/agents/forge/anthropic" \
  --secret-string "{\"ANTHROPIC_API_KEY\":\"$ANTHROPIC_API_KEY\"}"
```

### 4b. Via AWS CLI directly (alternative)

```bash
# Conductor Slack tokens
aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id "gg-sandbox/agents/conductor/slack" \
  --secret-string "{
    \"SLACK_BOT_TOKEN\":\"$CONDUCTOR_BOT_TOKEN\",
    \"SLACK_APP_TOKEN\":\"$CONDUCTOR_APP_TOKEN\"
  }"

# Forge Slack tokens
aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id "gg-sandbox/agents/forge/slack" \
  --secret-string "{
    \"SLACK_BOT_TOKEN\":\"$FORGE_BOT_TOKEN\",
    \"SLACK_APP_TOKEN\":\"$FORGE_APP_TOKEN\"
  }"
```

### What the runtime does with these secrets

At each gateway start, the systemd unit runs `ExecStartPre=/usr/local/bin/fetch-agent-secrets` which:
1. Calls `aws secretsmanager get-secret-value` for both the agent's `slack` and `anthropic` secrets
2. Merges the two JSON blobs into a flat key=value file at `/run/openclaw-<agent_id>.env`
3. The systemd `EnvironmentFile=/run/openclaw-<agent_id>.env` directive makes these available to the `openclaw gateway` process

The gateway process will have `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` in its environment at startup. OpenClaw reads the Anthropic API key from the `ANTHROPIC_API_KEY` environment variable natively (standard Anthropic SDK pattern). `SLACK_SIGNING_SECRET` is not stored or injected — it is not used by socket-mode bots.

---

## Step 4b: Populate GitHub App Credentials (Optional)

Each agent can optionally get a GitHub App for read+write access to its project repo. This step is only needed if you want the agent to push code, open PRs, or manage issues — the gateway starts fine without GitHub credentials.

For each agent that needs GitHub access:

1. Create the GitHub App and generate a private key (see [`docs/GITHUB-APPS.md`](../../GITHUB-APPS.md) for the full creation flow)
2. Install the app on the agent's project repo and note the Installation ID
3. Store the credentials (prefer the CLI; fall back to the bash script if no Node runtime):

**CLI (preferred):**
```bash
fleetmind github-app store \
  --fleet gg-sandbox \
  --agent <agent_id> \
  --app-id <app-id> \
  --installation-id <installation-id> \
  --pem-file /path/to/private-key.pem
```

**Bash fallback:**
```bash
infra/scripts/store-bot-github-app.sh \
  --fleet gg-sandbox \
  --agent <agent_id> \
  --app-id <app-id> \
  --installation-id <installation-id> \
  --pem-file /path/to/private-key.pem
```

The agent's IAM role (provisioned by Terraform) already has SSM read permissions scoped to its own `/fleetmind/gg-sandbox/agents/<agent_id>/github-app/*` path. No IAM changes are needed.

To verify after storing, SSH into the agent EC2 and run `gh-app-token` — it should print a short-lived token.

> **Skip this step** if your agents don't need to push to GitHub yet. You can always add credentials later without redeploying.

---

## Step 4c: Discover bot user_ids

Run this after **Step 4a** (populate Slack secrets) and optionally after **Step 4b** (GitHub App store). It fetches each agent's bot token from Secrets Manager, calls Slack `auth.test`, and writes the discovered `bot_user_id` back into `fleet.yaml` automatically.

```bash
fleetmind slack discover --fleet fleet.yaml --region us-west-2
```

For a dry run (no writes to `fleet.yaml`):
```bash
fleetmind slack discover --fleet fleet.yaml --region us-west-2 --dry-run
```

To re-run for a single agent (e.g. after token rotation or adding a new agent):
```bash
fleetmind slack discover --fleet fleet.yaml --region us-west-2 --agent forge
```

To overwrite `bot_user_id` values that are already set:
```bash
fleetmind slack discover --fleet fleet.yaml --region us-west-2 --force
```

After discovery runs, **re-render** so the discovered IDs propagate into `rendered/openclaw/<agent>/openclaw.json`:

```bash
fleetmind render
```

The renderer uses `bot_user_id` from `fleet.yaml` to derive per-channel `users` allowlists for inter-bot Slack message delivery. Without running discover first, agents in shared channels won't have bot-specific allowlist entries.

---

## Step 5: Render & Deploy Workspaces

### 5a. Render locally

```bash
cd /path/to/fleetmind

# Sanity check: confirm fleetmind is installed and authenticated against GitHub Packages
# (requires the npm auth setup from Prerequisites above)
fleetmind --version

# Ensure all token env vars are set in your shell (see Prerequisites)
# The loader expands ${VAR} references in fleet.yaml at parse time,
# so rendered files will contain actual token values — not placeholders.

fleetmind render
```

This writes to `./rendered/`:
```
rendered/
  openclaw/
    conductor/
      openclaw.json      ← per-agent config for the conductor gateway (see Step 5b)
    forge/
      openclaw.json      ← per-agent config for the forge gateway
  fleet.derived.tfvars      ← Terraform variable overrides
  workspaces/
    conductor/           ← SOUL.md, AGENTS.md, IDENTITY.md, USER.md, skills/
    forge/               ← same
```

Inspect the rendered `openclaw.json` for an agent to confirm tokens are placeholders (not baked-in):
```bash
cat rendered/openclaw/conductor/openclaw.json | jq '.channels.slack.accounts'
```

### 5b. What `openclaw.json` contains — per-agent slices

`fleetmind render` emits one `openclaw.json` **per agent** via `renderAgentOpenClawJson()` (in `src/runtime/renderer.ts`). Each file contains only what that agent's gateway needs — the render-vs-deploy topology mismatch has been resolved.

Per-agent slice contents:

| Section | Contents |
|---------|----------|
| `agents.list` | **Only this agent's entry.** `default: true` on the orchestrator only. |
| `bindings` | **Only this agent's** Slack accountId → agentId routing entry. |
| `channels.slack.accounts` | **Only this agent's** Slack account (botToken, appToken, webhookPath, groupPolicy). |
| `tools.agentToAgent.allow` | **Only entries where `from === <this agent>`** — outbound delegation routes only. |
| `plugins.entries` | **Only this agent's** plugin list (not the union of all agents). |
| `channels.slack` | mode, typing/ack reactions, allowBots, historyLimit, streaming — shared, unchanged. |
| `gateway` | port (18789), mode (local), bind (loopback) — shared, unchanged. |
| `tools` | profile (coding), web search (disabled in test fleet) — shared, unchanged. |
| `session` | dmScope (per-channel-peer) — shared, unchanged. |
| `hooks.internal` | boot-md, session-memory, command-logger — shared, unchanged. |
| `commands` | native: auto, nativeSkills: auto, restart: true — shared, unchanged. |

**What is NOT in `openclaw.json`:**
- **Anthropic API key** — intentionally absent. Delivered via `EnvironmentFile` from Secrets Manager (`ANTHROPIC_API_KEY`). OpenClaw reads it from environment; no credential entry needed in the config file.
- **Gateway auth** — no `gateway.auth` section. See Step 5c.

### 5c. Onboarding — `openclaw onboard` and why you skip it

> **tl;dr: `openclaw onboard` is never run in a FleetMind deploy. FleetMind replaces it entirely. Skip to Step 5d.**

In a normal (non-FleetMind) OpenClaw deploy — the pattern Carpe uses for their bots — the operator runs `openclaw onboard` manually on each EC2 instance after provisioning. Carpe's `userdata.sh.tftpl` explicitly says:

```
# Don't include anything related to configuring openclaw in the userdata.
# Onboard manually.
```

The intent: `openclaw onboard` is an interactive setup command. It prompts for Slack tokens, the LLM API key, gateway port and auth, installs the systemd daemon, and bootstraps workspace files. The Carpe pattern keeps the bootstrap lean and defers all OpenClaw configuration to a human-driven post-provision step.

**FleetMind's approach is a deliberate divergence from the Carpe pattern.** It replaces every piece of what `openclaw onboard` does with automated, declarative equivalents:

| What `openclaw onboard` does | FleetMind replacement | Status |
|---|---|---|
| Produces `openclaw.json` (agents, bindings, channels, gateway, tools, plugins) | `fleetmind render` → `renderOpenClawJson()` — baked from `fleet.yaml` at render time | ✅ Complete |
| Collects Slack bot/app tokens interactively | `fleetmind secrets populate` → Secrets Manager → `ExecStartPre fetch-agent-secrets` → `EnvironmentFile` | ✅ Complete |
| Prompts for Anthropic API key | Same secrets path → `ANTHROPIC_API_KEY` in `EnvironmentFile`; OpenClaw reads from env | ✅ Complete |
| Installs systemd unit | Bootstrap script writes unit directly in user_data STAGE 9 | ✅ Complete |
| Bootstraps workspace files (SOUL.md, AGENTS.md, etc.) | `fleetmind deploy` provisioner runs `provisionAgent()` for each agent | ✅ Complete |
| Sets up search provider | `fleet.yaml` → `openclaw.tools.web_search` section | ✅ Complete |
| Configures gateway auth (token or password) | **Not configured — explicit gap** | ⚠️ See below |

**The one gap: gateway auth**

The rendered `openclaw.json` has no `gateway.auth` section. `openclaw onboard` would normally set either a token (`--gateway-auth token`) or password (`--gateway-auth password`).

This is acceptable for the gg-sandbox test deploy because:
- The gateway binds to `loopback` (`127.0.0.1`) only — not reachable from the network
- Agents run in private subnets with no public IPs
- The only external access path is SSM Session Manager (IAM-authenticated)
- There is no exposed HTTP/WebSocket port to protect

**If you need gateway auth** (e.g., to connect the OpenClaw mobile app to an agent remotely, or to enable remote gateway pairing), add it once per instance via SSM after the gateway starts:

```bash
aws ssm start-session \
  --region us-west-2 \
  --target <instance-id> \
  --document-name AWS-StartInteractiveCommand \
  --parameters command="sudo -u ec2-user bash -c 'WORKSPACE_DIR=/opt/openclaw/workspace/conductor openclaw onboard --non-interactive --accept-risk --flow manual --gateway-auth token --gateway-token YOUR_TOKEN_HERE --skip-channels --skip-bootstrap --skip-skills --skip-search --no-install-daemon --workspace /opt/openclaw/workspace/conductor'"
```

This runs `openclaw onboard` in non-interactive mode, touching ONLY the gateway auth config (`--skip-channels --skip-bootstrap --skip-skills --skip-search --no-install-daemon`), leaving the existing `openclaw.json` otherwise intact. Repeat for each agent.

For the test deploy, skip this entirely. The gateway will start fine without auth on a loopback-only private instance.

**Summary:** FleetMind's rendered `openclaw.json` is complete for normal fleet operation. The only thing `openclaw onboard` could add that FleetMind doesn't provide is gateway auth — and that's only needed for remote gateway access, not local-only fleet operation.

### 5d. Transport workspaces to EC2

Use `fleetmind push fleet` to package and deploy workspaces in one command. This
replaces the manual tar / S3 copy / SSM flow.

**Prerequisites:**
- Create the deploy-staging S3 bucket (one-time):
  ```bash
  aws s3 mb s3://gg-sandbox-ledger --region us-west-2
  ```
- Your AWS identity needs `ssm:SendCommand`, `ssm:DescribeInstanceInformation`, and
  `s3:PutObject` on `gg-sandbox-ledger/deploy-staging/*`. See `docs/OPERATING.md` for
  the full IAM policy.

**Dry-run first (always recommended):**

```bash
fleetmind push fleet --dry-run
```

This renders, packages, and prints a per-agent file manifest (count + total size) but
does **not** upload anything or trigger any bots.

**Full push:**

```bash
fleetmind push fleet
```

This:
1. Renders workspaces + per-agent `openclaw.json` (same as `fleetmind deploy`)
2. Packages each agent's workspace into a signed tarball
3. Uploads tarball + manifest to `s3://gg-sandbox-ledger/deploy-staging/`
4. Sends an SSM command to each agent to run `fleetmind pull-self --apply`
5. Prints the SSM command ID per agent for follow-up

Check that each agent applied successfully:
```bash
aws ssm get-command-invocation \
  --command-id <cmd-id-from-push-summary> \
  --instance-id <instance-id> \
  --region us-west-2 \
  --query 'StandardOutputContent' --output text
```

**Push and restart gateways in one step:**

```bash
fleetmind push fleet --restart
```

---

> **Fallback: manual SCP / SSM (if `push fleet` isn't available)**
>
> The original manual steps are preserved below for reference if you need to bootstrap
> an instance that doesn't yet have `fleetmind` installed, or in case of emergency.
>
> ```bash
> CONDUCTOR_IP=$(terraform -chdir=infra/terraform output -json private_ips | jq -r '.conductor')
> FORGE_IP=$(terraform -chdir=infra/terraform output -json private_ips | jq -r '.forge')
>
> # SCP workspaces (requires bastion or VPN)
> scp -i ~/.ssh/your-key.pem -J ec2-user@<bastion-ip> \
>   -r ./rendered/workspaces/conductor ec2-user@$CONDUCTOR_IP:/opt/openclaw/workspace/
> scp -i ~/.ssh/your-key.pem -J ec2-user@<bastion-ip> \
>   -r ./rendered/workspaces/forge ec2-user@$FORGE_IP:/opt/openclaw/workspace/
>
> # SCP per-agent openclaw.json
> scp -i ~/.ssh/your-key.pem -J ec2-user@<bastion-ip> \
>   ./rendered/openclaw/conductor/openclaw.json \
>   ec2-user@$CONDUCTOR_IP:/opt/openclaw/workspace/conductor/.openclaw/openclaw.json
> scp -i ~/.ssh/your-key.pem -J ec2-user@<bastion-ip> \
>   ./rendered/openclaw/forge/openclaw.json \
>   ec2-user@$FORGE_IP:/opt/openclaw/workspace/forge/.openclaw/openclaw.json
>
> # SSM file push (no bastion — for post-launch updates)
> for AGENT in conductor forge; do
>   INSTANCE_ID=$(terraform -chdir=infra/terraform output -json instance_ids | jq -r ".$AGENT")
>   tar czf /tmp/${AGENT}-workspace.tar.gz -C ./rendered/workspaces ${AGENT}
>   B64=$(base64 -w0 /tmp/${AGENT}-workspace.tar.gz)
>   aws ssm send-command --region us-west-2 --instance-ids $INSTANCE_ID \
>     --document-name AWS-RunShellScript \
>     --parameters "commands=[\"echo '$B64' | base64 -d > /tmp/${AGENT}-workspace.tar.gz\",\"tar xzf /tmp/${AGENT}-workspace.tar.gz -C /opt/openclaw/workspace/\",\"chown -R ec2-user:ec2-user /opt/openclaw/workspace/${AGENT}\"]"
> done
> ```

### 5e. Verify workspace layout on EC2

Spot-check via SSM:
```bash
aws ssm start-session \
  --region us-west-2 \
  --target $CONDUCTOR_ID \
  --document-name AWS-StartInteractiveCommand \
  --parameters command="ls -la /opt/openclaw/workspace/conductor/ && cat /opt/openclaw/workspace/conductor/.openclaw/openclaw.json | jq '.agents.list[].id'"
```

Expected workspace layout:
```
/opt/openclaw/workspace/conductor/
  .openclaw/
    openclaw.json
  SOUL.md
  AGENTS.md
  IDENTITY.md
  USER.md
  skills/
    bot-delegation/
  cron/
    jobs.json
```

---

## Step 6: Start Gateways

Both agents have their systemd units installed and **enabled** (set to start on boot) but **not yet started** — the bootstrap deliberately stops short of `systemctl start` (PR #37 fix). Start them now via SSM:

### 6a. Start conductor

```bash
CONDUCTOR_ID=$(terraform -chdir=infra/terraform output -json instance_ids | jq -r '.conductor')

aws ssm send-command \
  --region us-west-2 \
  --instance-ids $CONDUCTOR_ID \
  --document-name AWS-RunShellScript \
  --parameters commands=["systemctl start openclaw-conductor && systemctl status openclaw-conductor --no-pager"] \
  --query 'Command.CommandId' --output text
```

Check the command output:
```bash
aws ssm list-command-invocations \
  --region us-west-2 \
  --command-id <command-id-from-above> \
  --details \
  --query 'CommandInvocations[0].CommandPlugins[0].Output' \
  --output text
```

### 6b. Start forge

```bash
FORGE_ID=$(terraform -chdir=infra/terraform output -json instance_ids | jq -r '.forge')

aws ssm send-command \
  --region us-west-2 \
  --instance-ids $FORGE_ID \
  --document-name AWS-RunShellScript \
  --parameters commands=["systemctl start openclaw-forge && systemctl status openclaw-forge --no-pager"]
```

### 6c. Verify gateways are healthy

For each instance, check the journal:
```bash
aws ssm start-session \
  --region us-west-2 \
  --target $CONDUCTOR_ID \
  --document-name AWS-StartInteractiveCommand \
  --parameters command="journalctl -u openclaw-conductor -n 50 --no-pager"
```

Healthy log lines look like:
```
openclaw-conductor[...]: OpenClaw 2026.x.x — gateway starting
openclaw-conductor[...]: Slack socket connection established
openclaw-conductor[...]: Agent conductor ready
```

If the service fails:
1. Check secrets are populated: `aws secretsmanager get-secret-value --secret-id gg-sandbox/agents/conductor/slack --region us-west-2`
2. Check the env file was written: `cat /run/openclaw-conductor.env` (accessible via SSM)
3. Check `ExecStartPre` logs in journal: `journalctl -u openclaw-conductor -n 100` — look for `[secrets]` lines from `fetch-agent-secrets`
4. Confirm `openclaw.json` is at `/opt/openclaw/workspace/conductor/.openclaw/openclaw.json` (the gateway defaults to reading from `$WORKSPACE/.openclaw/openclaw.json`)

---

## Step 6b: Fleet Roster (automated)

The renderer automatically derives a `## Fleet Members` section in each agent's AGENTS.md from fleet.yaml (after `fleetmind slack discover` populates the `bot_user_id` values). The manual Slack handshake is no longer needed — bots boot with the roster baked into their workspace.

If you add a new agent to the fleet later, re-run `fleetmind slack discover` to populate the new agent's `bot_user_id`, then `fleetmind push fleet` to redeploy with updated rosters.

---

## Step 7: Smoke Tests

### 7a. Conductor responds in Slack

Send a DM to the Conductor Slack app:
```
Hello, Conductor. What can you do?
```

Expected: Conductor responds within ~5 seconds. If the `:thinking_face:` reaction appears and a reply follows, the gateway is reading the Slack event and calling the LLM.

### 7b. Agent-to-agent routing works

Confirm Conductor can see Forge in its routing config:
```
@Conductor who are your worker bots?
```

Expected: Conductor lists Forge (this tests the `agentToAgent.allow` config and the `bot-delegation` skill awareness).

### 7c. Delegation flow (if delegation is enabled)

1. DM Conductor a task that it should delegate:
   ```
   Please have Forge summarize the current state of the codebase.
   ```

2. Watch the task ledger in DynamoDB:
   ```bash
   aws dynamodb scan \
     --region us-west-2 \
     --table-name gg-sandbox-tasks \
     --query 'Items[*].{id:task_id.S, status:status.S, worker:worker_id.S}' \
     --output table
   ```

3. Check that Forge's gateway logged receiving the delegation envelope:
   ```bash
   aws ssm start-session --region us-west-2 --target $FORGE_ID \
     --document-name AWS-StartInteractiveCommand \
     --parameters command="journalctl -u openclaw-forge -n 100 --no-pager | grep -i 'delegat\|task\|envelope'"
   ```

### 7d. ContextStore read/write

The DynamoDB context store is accessible to all agents. Verify the table exists and is writable:
```bash
aws dynamodb describe-table \
  --region us-west-2 \
  --table-name gg-sandbox-context-store \
  --query 'Table.{Status:TableStatus, Items:ItemCount}' \
  --output table
```

### 7e. NATS subscriber active on each agent

```bash
aws ssm start-session --region us-west-2 --target $CONDUCTOR_ID \
  --document-name AWS-StartInteractiveCommand \
  --parameters command="systemctl status fleetmind-nats-conductor"
```

Confirm the unit is `active (running)`. Wake-on-NATS replaced the pre-0.8 `WORKER_SWEEP` cron sweeps; close-the-loop fires on the worker's `task.shipped` / `task.blocked` event, not on a poll.

---

## Step 8: Teardown

When testing is done:

```bash
# From infra/terraform/modules/task-ledger:
cd infra/terraform/modules/task-ledger
terraform destroy \
  -var="fleet_name=gg-sandbox" \
  -var="aws_region=us-west-2" \
  -var="table_name=gg-sandbox-tasks" \
  -var="s3_bucket=gg-sandbox-narratives-251714435910" \
  -var="pm_role_names=[\"$CONDUCTOR_ROLE\"]" \
  -var="worker_role_names=[\"$FORGE_ROLE\"]"

# From infra/terraform (root):
cd ../..
terraform destroy -var-file=terraform-extras.tfvars
```

> The task-ledger DynamoDB table has `prevent_destroy = true` — intentional (task data is irreplaceable in production). For a test teardown, remove the lifecycle block from `modules/task-ledger/main.tf` before running destroy, or delete the table manually first:
> ```bash
> aws dynamodb delete-table --region us-west-2 --table-name gg-sandbox-tasks
> ```

---

## Appendix A: Known TF Smells (non-blocking, fix post-test)

### A1. DynamoDB context-store table name doubles fleet_name
**File:** `infra/terraform/dynamodb.tf`  
With `fleet_name = "fleetmind"` (the default), the table is named `fleetmind-fleetmind`. The gg-sandbox fleet uses `fleet_name = "gg-sandbox"` which produces `gg-sandbox-gg-sandbox`. Not a functional problem but looks wrong.  
**Fix:** `name = "${var.fleet_name}-context-store"`

### A2. Tag schema inconsistency
**File:** `infra/terraform/dynamodb.tf`  
Resource-level tags use `snake_case` (`fleet_name`, `managed_by`) while the provider's `default_tags` uses `PascalCase` (`Project`, `ManagedBy`). Both are additive so the table gets both schemas. Tag-based cost queries against a single schema will miss resources.  
**Fix:** Normalize dynamodb.tf tags to `{ Name = "${var.fleet_name}-context-store" }`.

### A3. Provider version ceiling missing from task-ledger module
**File:** `infra/terraform/modules/task-ledger/main.tf`  
Module requires `>= 5.0` (open-ended); root requires `~> 5.0` (locked to 5.x). When the root upgrades to `~> 6.0`, the asymmetry will look like a bug.  
**Fix:** Add `< 6.0` ceiling to task-ledger, or align both to `~> 6.0` and migrate `hash_key` → `key_schema`.

### A4. No validation on `wake_target_session_key` when delegation is enabled
**File:** `infra/terraform/variables.tf`  
An empty `wake_target_session_key` silently breaks the EventBridge→SSM wake pipeline.  
**Fix:**
```hcl
validation {
  condition     = !var.delegation_enabled || length(var.wake_target_session_key) > 0
  error_message = "wake_target_session_key must be set when delegation_enabled = true."
}
```

---

## Appendix B: Carpe Pattern vs FleetMind Pattern

| | Carpe bots | FleetMind |
|---|---|---|
| **Config approach** | Manual `openclaw onboard` on each instance post-provision | Declarative `fleet.yaml` → `fleetmind render` → `openclaw.json` |
| **`openclaw onboard` run?** | ✅ Yes — deliberately deferred to post-provision | ❌ No — replaced entirely |
| **Slack tokens** | Entered interactively via `onboard` | `fleetmind secrets populate` → Secrets Manager → EnvironmentFile |
| **LLM API key** | Entered interactively via `onboard` | Secrets Manager → `ANTHROPIC_API_KEY` in EnvironmentFile |
| **Workspace files** | Created by `onboard` (default workspace bootstrap) | `fleetmind deploy` provisioner → SCP to EC2 |
| **Systemd unit** | Written by `onboard --install-daemon` | Bootstrap script writes unit directly in user_data |
| **Gateway auth** | Configured by `onboard` (token or password) | Not configured (loopback-only, acceptable) |
| **AMI** | Custom Carpe golden AMI (arm64, SSM pre-installed) | Public AL2023 x86_64 (`al2023-ami-2023*`) + bootstrap installs SSM agent |
| **Service user** | Dedicated `openclaw` system user | `ec2-user` (shared account — acceptable for single-agent-per-EC2) |
| **Node.js** | NodeSource RPM via `dnf` | NVM (more fragile in cloud-init; works but watch for transient curl failures) |

Carpe's deliberate choice ("onboard manually, not in userdata") reflects the same principle FleetMind automates: keeping userdata lean and deferring OpenClaw config to a well-understood, reproducible process. FleetMind's innovation is making that process declarative and fleet-wide rather than per-instance interactive.

---

## Appendix C: Quick Reference Commands

```bash
# SSM interactive session
aws ssm start-session --region us-west-2 --target <instance-id>

# Start/stop/status gateway
systemctl start openclaw-conductor
systemctl stop openclaw-conductor
systemctl status openclaw-conductor --no-pager
journalctl -u openclaw-conductor -f

# Check env file (secrets loaded at last start)
cat /run/openclaw-conductor.env

# Check rendered config
cat /opt/openclaw/workspace/conductor/.openclaw/openclaw.json | jq .

# Re-fetch secrets manually (runs ExecStartPre manually)
/usr/local/bin/fetch-agent-secrets gg-sandbox conductor /run/openclaw-conductor.env us-west-2

# Check SSM registration
aws ssm describe-instance-information --region us-west-2

# Tail EC2 console output
aws ec2 get-console-output --instance-id <id> --region us-west-2 --query Output --output text

# Terraform outputs
terraform -chdir=infra/terraform output -json

# Verify Secrets Manager value
aws secretsmanager get-secret-value \
  --region us-west-2 \
  --secret-id gg-sandbox/agents/conductor/slack \
  --query SecretString --output text | jq .
```
