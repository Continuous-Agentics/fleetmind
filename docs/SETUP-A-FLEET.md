# Setting Up a New FleetMind Fleet

This guide walks through bringing up a new fleet from scratch: defining agents, provisioning AWS infrastructure, wiring Slack apps, deploying workspaces, and verifying the system end-to-end.

**Audience:** Someone who has fleetmind installed and an AWS account, and wants to bring up a brand-new fleet.

**Time estimate:** 45–90 minutes for a first fleet (most of it is waiting on AWS bootstraps and manually clicking through Slack app creation).

---

## 1. Prerequisites

### Tools (local machine)

- **Node.js ≥ 20** and **npm ≥ 10**
- **Terraform ≥ 1.5** (or use `tfenv` — `.terraform-version` is committed in the repo)
- **AWS CLI v2**, configured with credentials for your target account
- **fleetmind CLI:**

  ```bash
  npm install -g @continuous-agentics/fleetmind
  ```

  fleetmind is published to GitHub Packages under `@continuous-agentics`. You need a GitHub classic PAT with `read:packages` scope to install it (see §3c below for the SSM side; the same PAT goes in your local `~/.npmrc`):

  ```bash
  echo "@continuous-agentics:registry=https://npm.pkg.github.com" >> ~/.npmrc
  echo "//npm.pkg.github.com/:_authToken=<YOUR_PAT>" >> ~/.npmrc
  npm install -g @continuous-agentics/fleetmind
  ```

### AWS account

- Admin-level access (or a custom policy covering EC2, VPC, IAM, SSM, Secrets Manager, S3, DynamoDB, EventBridge, and CloudWatch Logs)
- The target region ready (default: `us-west-2`)

### Slack workspace

- Admin access to a Slack workspace where you can create new apps and channels

### GitHub (optional)

- A repo that each bot will operate against (for code, PRs, issues)
- A GitHub PAT with `read:packages` for installing fleetmind on EC2 instances (required for bootstrapping)

---

## 2. Define Your Fleet (`fleet-<name>.yaml`)

The fleet YAML is the single source of truth. Everything — Terraform variables, per-agent `openclaw.json`, workspace files — is derived from it by `fleetmind render`.

### Naming conventions

- **`fleet.name`** becomes the prefix for all AWS resource names: VPC, EC2 instances, IAM roles, S3 bucket, DynamoDB table, Secrets Manager paths. Keep it short and lowercase (e.g., `acme-bots`).
- **Agent `id`** values are lowercase identifiers (e.g., `blanket`, `charlie`). They appear in SSM paths, service unit names, and workspace directories.

### Annotated example

The following is a real fleet definition — one orchestrator PM and one worker — heavily annotated:

```yaml
# fleet-acme-bots.yaml
# One PM bot (orchestrator) + one backend worker.
# Operator workflow (quick reference):
#   fleetmind slack manifests --fleet fleet-acme-bots.yaml --out ./rendered/slack-manifests-acme-bots/
#   # Create Slack apps from manifests. Fill in slack.channels[] per agent below.
#   fleetmind render fleet-acme-bots.yaml
#   cd infra/terraform && terraform workspace select acme-bots
#   terraform apply -var-file=workspaces/acme-bots.tfvars -var-file=workspaces/acme-bots.auto.tfvars
#   fleetmind secrets populate --fleet fleet-acme-bots.yaml --interactive --region us-west-2
#   fleetmind slack discover --fleet fleet-acme-bots.yaml --region us-west-2
#   fleetmind render fleet-acme-bots.yaml           # second render — now has bot_user_ids
#   fleetmind push fleet --fleet fleet-acme-bots.yaml --restart

fleet:
  name: acme-bots          # → prefix for all AWS resources (keep it short)
  version: "1.0.0"
  client: "Acme Corp"
  description: "Acme PM + backend worker fleet"

# Task-ledger (inter-bot delegation). Must match DynamoDB table + S3 bucket
# that Terraform will create. If you change fleet.name you also change these.
delegation:
  enabled: true
  aws_region: us-west-2
  table_name: acme-bots-tasks        # created by TF module "task_ledger"
  s3_bucket: acme-bots-ledger        # S3 bucket for task artifacts (TF default: ${fleet_name}-ledger)

agents:
  # Defaults applied to all agents unless overridden.
  defaults:
    model: anthropic/claude-haiku-4-5
    workspace_base: /opt/openclaw/workspace
    plugins:
      - anthropic

  list:
    # ── PM bot (orchestrator) ──────────────────────────────────────────────
    - id: blanket
      name: Blanket
      emoji: 🐈
      role: pm
      description: "Project-manager bot"
      orchestrator: true             # ← exactly one agent should be true
      model: anthropic/claude-sonnet-4-6  # PMs typically run a stronger model

      persona:
        soul: |
          You are Blanket, a project-manager bot. You receive tasks from humans,
          delegate to worker bots via the bot-delegation skill, track everything
          in a task ledger, and close the loop on every assignment.

      slack:
        account_id: blanket
        # bot_user_id filled in by `fleetmind slack discover` after secrets populate.
        # bot_user_id: "U…"
        channels:
          - "C…"    # PM's home channel (humans DM here)
          - "C…"    # shared delegation channel (workers also join this one)
        bot_token: "${BLANKET_BOT_TOKEN}"
        app_token: "${BLANKET_APP_TOKEN}"
        background_color: "#2C3E50"
        long_description: >
          Blanket is the PM bot for the acme-bots fleet. It delegates work to
          Charlie (backend worker), tracks tasks in DynamoDB, and closes the loop.

      skills:
        - name: bot-delegation      # PM skill — assigns tasks to workers
          source: fleetmind

      agent_to_agent:
        can_send_to: [charlie]      # which workers this PM can delegate to

      delegation:
        worker_bots: [charlie]
        sweeps:
          - name: blanket-sweep-charlie
            worker_id: charlie
            every: 5m              # check for task completions every 5 minutes
            model: anthropic/claude-haiku-4-5

    # ── Worker bot ─────────────────────────────────────────────────────────
    - id: charlie
      name: Charlie
      emoji: ⚙️
      role: backend-worker
      description: "Backend specialty worker"
      orchestrator: false

      persona:
        soul: |
          You are Charlie, a backend worker. You accept delegated tasks from
          Blanket, acknowledge with :eyes:, ship the work, and report back.

      slack:
        account_id: charlie
        # bot_user_id: "U…"  (filled by `fleetmind slack discover`)
        channels:
          - "C…"    # shared delegation channel (same as PM's delegation channel)
        bot_token: "${CHARLIE_BOT_TOKEN}"
        app_token: "${CHARLIE_APP_TOKEN}"
        background_color: "#8B4513"
        long_description: >
          Charlie is the backend worker for the acme-bots fleet. Receives task
          envelopes from Blanket, ships work, and posts completion summaries.

      skills:
        - name: bot-reception       # worker skill — receives delegated tasks
          source: fleetmind

      agent_to_agent:
        can_send_to: [blanket]      # workers send results back to PM

      delegation:
        specialty: backend

# Output paths — where render writes derived files.
# These must be passed to terraform apply via -var-file.
outputs:
  openclaw_json: ./rendered/openclaw-acme-bots.json
  terraform_vars: ./infra/terraform/workspaces/acme-bots.auto.tfvars

# Gateway and Slack behavior shared across the fleet.
openclaw:
  gateway:
    port: 18789         # base port; each agent gets port + index
    mode: local
    bind: loopback
  session:
    dm_scope: per-channel-peer
  tools:
    profile: coding
    web_search:
      enabled: false
      provider: duckduckgo
  slack:
    mode: socket        # socket-mode: no inbound HTTPS needed, no signing_secret required
    typing_reaction: black_cat
    ack_reaction: eyes
    allow_bots: true
    history_limit: 50
    streaming:
      mode: partial
      native_transport: true
    reply_to_mode_by_chat_type:
      channel: all
```

Key points:
- Exactly one agent has `orchestrator: true` (the PM). The renderer derives `wake_target_session_key` from the PM's first `slack.channels[]` entry — Slack must be created **before** the first render.
- `delegation.table_name` and `delegation.s3_bucket` must match what Terraform will create (defaults are `${fleet_name}-tasks` and `${fleet_name}-ledger`).
- `outputs.terraform_vars` is the auto.tfvars path — it must be in `infra/terraform/workspaces/`.

---

## 3. One-Time per-Account Setup

> Skip this section if your account already has remote TF state, a lock table, and the GitHub Packages token in SSM.

### 3a. Create the TF state lock table

The DynamoDB lock table cannot be managed by the Terraform it locks (chicken-and-egg). Create it once per AWS account:

```bash
aws dynamodb create-table \
  --table-name fleetmind-tf-state-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-2
```

### 3b. Pick or create an S3 bucket for Terraform state

An existing account-level content bucket works fine. Or create a dedicated one:

```bash
aws s3api create-bucket \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-bucket-versioning \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --versioning-configuration Status=Enabled
```

### 3c. Store the GitHub Packages PAT in SSM

EC2 instances pull fleetmind from GitHub Packages during bootstrap. They need a PAT with `read:packages` scope, stored in SSM:

```bash
# Generate a classic PAT at https://github.com/settings/tokens (read:packages scope)
aws ssm put-parameter \
  --name /fleetmind/shared/github-packages-token \
  --type SecureString \
  --value <YOUR_PAT> \
  --region us-west-2
```

### 3d. Configure the local Terraform backend

```bash
cd infra/terraform
cp backend.example.hcl backend.hcl
$EDITOR backend.hcl   # fill in: bucket, region, dynamodb_table
```

`backend.hcl` is gitignored — each operator maintains their own copy.

```hcl
# backend.hcl (example)
bucket         = "my-tfstate-bucket"
key            = "fleetmind/terraform.tfstate"
region         = "us-west-2"
dynamodb_table = "fleetmind-tf-state-lock"
```

Initialize Terraform with the backend:

```bash
terraform init -backend-config=backend.hcl
```

---

## 4. Per-Fleet Setup

### 4a. Create a Terraform workspace

Each fleet gets its own isolated Terraform workspace (and therefore its own state file):

```bash
cd infra/terraform
terraform workspace new acme-bots
terraform workspace select acme-bots
```

State lands at `s3://<bucket>/env:/acme-bots/fleetmind/terraform.tfstate` automatically.

### 4b. Write the infra-only tfvars

Create `infra/terraform/workspaces/acme-bots.tfvars` with infrastructure-only settings. **Do not set** `fleet_name`, `agent_names`, `agent_models`, `agent_orchestrators`, or `wake_target_session_key` here — `fleetmind render` derives those and writes them to `acme-bots.auto.tfvars`.

```hcl
# workspaces/acme-bots.tfvars — infra knobs only

aws_region    = "us-west-2"
instance_type = "t3.medium"    # or t4g.medium for arm64 Graviton

# Gateway port per agent. Keys must match agent ids in fleet.yaml.
agent_ports = {
  blanket = 18789
  charlie = 18790
}

# Software versions pinned to a known-good release.
openclaw_version  = "latest"
node_version      = "22"
fleetmind_version = "0.4.3"   # pin to current stable

# Task-ledger module (inter-bot delegation DynamoDB + EventBridge).
delegation_enabled = true

# RDS — fleetmind doesn't use it today.
enable_rds = false

# VPC interface endpoints for SSM/SecretsManager (avoids NAT for those calls).
# Costs ~$80/mo; turn off to save money on small fleets.
enable_interface_endpoints = false

# Per-agent instance type overrides. Omit to use instance_type for all.
agent_instance_types = {}
```

### 4c. Generate Slack app manifests

```bash
fleetmind slack manifests --fleet fleet-acme-bots.yaml --out ./rendered/slack-manifests-acme-bots/
```

This writes one YAML manifest per agent into the output directory. You'll paste each one into the Slack UI in the next step.

### 4d. Create Slack apps and channels (manual, UI)

Do this for **each agent** in your fleet:

**Create the Slack app:**

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Choose your workspace
3. Paste the YAML from `./rendered/slack-manifests-acme-bots/<agent-id>.yaml`
4. Click **Create** → **Install App** → **Allow**
5. From **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`)
6. From **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**:
   - Scope: `connections:write`
   - Copy the **App-Level Token** (`xapp-…`)

**Create channels in Slack:**

- For the PM: create a home channel (`#acme-bots-pm` or similar) and a shared delegation channel (`#acme-bots-delegation`)
- For workers: they only join the delegation channel
- `/invite @<botname>` to each channel the bot should be in
- Copy each channel ID (right-click channel → **Copy link** — the ID is the `C…` segment at the end)

### 4e. Fill channel IDs into fleet.yaml

Update each agent's `slack.channels` with the real channel IDs:

```yaml
# PM agent
slack:
  channels:
    - "C0B3J7CT6RJ"   # home channel
    - "C0B3CGSNATG"   # delegation channel

# Worker agent
slack:
  channels:
    - "C0B3CGSNATG"   # delegation channel only
```

### 4f. First render

```bash
fleetmind render fleet-acme-bots.yaml
```

This writes:
- `./rendered/openclaw-acme-bots.json` (per-agent config slices)
- `./infra/terraform/workspaces/acme-bots.auto.tfvars` — **derived vars**, including `wake_target_session_key` (derived from the PM's first channel ID)

The auto.tfvars looks like:

```hcl
fleet_name             = "acme-bots"
agent_names            = { blanket = "Blanket", charlie = "Charlie" }
agent_models           = { blanket = "anthropic/claude-sonnet-4-6", charlie = "anthropic/claude-haiku-4-5" }
agent_orchestrators    = { blanket = true, charlie = false }
wake_target_session_key = "C0B3J7CT6RJ"   # PM's first channel
```

> **Why the channel must exist before render:** `wake_target_session_key` is derived from the PM's `slack.channels[0]` value. If channels aren't filled in yet, the auto.tfvars will have an empty value and the EventBridge task-ledger trigger won't work.

### 4g. Apply Terraform

```bash
cd infra/terraform
terraform workspace select acme-bots
terraform apply \
  -var-file=workspaces/acme-bots.tfvars \
  -var-file=workspaces/acme-bots.auto.tfvars
```

Review the plan. Expect roughly 60–80 resources to add (VPC, subnets, NAT, EC2 instances, IAM roles, SSM parameters, S3 bucket, DynamoDB table, EventBridge rules). Confirm with `yes`.

### 4h. Wait for bootstrap (~3–5 minutes)

Each EC2 instance runs a multi-stage bootstrap script on first launch. Watch for completion via console output:

```bash
# Get instance IDs from TF outputs
terraform output -json instance_ids

# For each agent:
INSTANCE_ID=$(terraform output -json instance_ids | jq -r '.blanket')
aws ec2 get-console-output \
  --instance-id "$INSTANCE_ID" \
  --region us-west-2 \
  --query 'Output' \
  --output text | tail -20
```

Look for:

```
[bootstrap] Done. Agent blanket provisioned.
```

If you don't see it after 5 minutes, check for errors earlier in the console output (common: missing SSM parameter, IAM permission gap, network connectivity).

### 4i. Populate secrets

```bash
fleetmind secrets populate \
  --fleet fleet-acme-bots.yaml \
  --interactive \
  --region us-west-2
```

This prompts for each agent's tokens and stores them in AWS Secrets Manager under `/fleetmind/<fleet_name>/agents/<agent_id>/…`. For each agent you'll need:

- `<AGENT>_BOT_TOKEN` — the `xoxb-…` token from the Slack app's OAuth page
- `<AGENT>_APP_TOKEN` — the `xapp-…` socket-mode token from Basic Information
- `ANTHROPIC_API_KEY` — your Anthropic API key (one per agent, can be the same key)

### 4j. Discover bot user IDs

```bash
fleetmind slack discover \
  --fleet fleet-acme-bots.yaml \
  --region us-west-2
```

This calls Slack's `auth.test` using the tokens you just stored, retrieves each bot's `U…` user ID, and writes it back into `fleet.yaml` under `slack.bot_user_id`. These IDs are required for inter-bot message delivery allowlists.

### 4k. Second render

```bash
fleetmind render fleet-acme-bots.yaml
```

Now that `bot_user_id` values are populated, the renderer includes peer bot IDs in each agent's per-channel `users` allowlist inside `openclaw.json`. Without this step, inter-bot messages from peers will be silently dropped.

### 4l. Push workspaces and start gateways

```bash
fleetmind push fleet \
  --fleet fleet-acme-bots.yaml \
  --restart
```

This:
1. Runs render (again, to ensure output is fresh)
2. Packages per-agent workspace tarballs
3. Uploads tarballs + manifests to S3 (`<fleet_name>-ledger/deploy-staging/`)
4. Triggers `fleetmind pull-self --apply --restart` on each bot via SSM

The `--restart` flag starts the gateway for the first time (the systemd unit has a `ConditionPathExists` guard — it won't attempt to start until `openclaw.json` is present in the workspace).

### 4m. Verify gateways are running

SSM into each instance to confirm:

```bash
# Look up an instance ID
INSTANCE_ID=$(aws ssm describe-instance-information \
  --filters "Key=tag:fleetmind:fleet_name,Values=acme-bots" \
            "Key=tag:fleetmind:agent_id,Values=blanket" \
  --query 'InstanceInformationList[0].InstanceId' \
  --output text \
  --region us-west-2)

aws ssm start-session --target "$INSTANCE_ID" --region us-west-2
```

Once inside:

```bash
sudo systemctl status openclaw-blanket --no-pager -l
sudo journalctl -u openclaw-blanket -n 50 --no-pager
```

Healthy output looks like:

```
● openclaw-blanket.service - OpenClaw Gateway (blanket)
   Active: active (running) since ...
...
[gateway] ready
[slack] socket mode connected
```

Repeat for each agent.

---

## 5. Smoke Test

**Basic connectivity:** DM the PM bot in its home channel. It should respond within a few seconds.

**Inter-bot delegation:** Ask the PM to delegate a simple task to the worker. Watch for the full round-trip:

1. PM posts a task envelope in the delegation channel mentioning `<@charlie-user-id>`
2. Worker reacts `:eyes:` to acknowledge pickup
3. Worker completes the task and posts a completion summary in the thread
4. PM's sweep (every 5 minutes, or nudge it manually) detects the `shipped` state and closes the loop

If the PM responds but inter-bot delivery is silent, check that `bot_user_id` values are correct in `fleet.yaml` and that `fleetmind slack discover` ran after secrets were populated (§4j).

---

## 6. GitHub Apps (Optional, Per Bot)

If your agents need to push code, open PRs, or manage issues, give each one a dedicated GitHub App. See [`docs/GITHUB-APPS.md`](./GITHUB-APPS.md) for the full pattern. Summary:

**Create the app** (one per agent that needs GitHub access):

1. Navigate to `https://github.com/organizations/<org>/settings/apps/new`
2. Name: `<FleetName> <AgentName> Bot` (e.g., "AcmeBots Blanket Bot")
3. Webhook: disabled
4. Repository permissions: Contents R+W, Pull requests R+W, Issues R+W, Actions R+W, Checks R, Metadata R
5. Install on the specific project repo only

**Store credentials:**

```bash
fleetmind github-app store \
  --fleet acme-bots \
  --agent blanket \
  --app-id <app-id> \
  --installation-id <installation-id> \
  --pem-file /path/to/blanket-bot.private-key.pem
```

Shred the local `.pem` after storing:

```bash
shred -u /path/to/blanket-bot.private-key.pem
```

**Verify on the bot EC2:**

```bash
gh-app-token   # should print a ghs_… installation token
```

---

## 7. Operating an Existing Fleet

After initial bring-up, day-to-day operations are covered in [`docs/OPERATING.md`](./OPERATING.md). Quick reference:

| Operation | Command |
|-----------|---------|
| Push workspace updates + restart | `fleetmind push fleet --fleet fleet-<name>.yaml --restart` |
| Preview what would be pushed | `fleetmind push fleet --dry-run` |
| Upgrade fleetmind on running bots | `fleetmind self-upgrade --latest --apply --restart` |
| Check bot diff without applying | `fleetmind pull-self` (run on bot EC2 via SSM) |
| Publish a new fleetmind version | See `RELEASING.md` |
| Run a second fleet in the same account | See `docs/MULTI-FLEET.md` |

---

## 8. Troubleshooting

### Gateway not starting on first deploy

**Symptom:** `systemctl status openclaw-<agent>` shows `ConditionPathExists was not met`.

**Cause:** The `openclaw.json` config file doesn't exist yet. The unit has a condition guard that prevents startup until the workspace is populated.

**Fix:** Run `fleetmind push fleet --fleet ... --restart`. This ships the workspace (including `openclaw.json`) and then restarts the unit. The restart flag is what triggers the first start, not systemd's automatic behavior.

### Inter-bot messages silently dropped

**Symptom:** PM posts a task envelope; worker never reacts or responds.

**Cause:** Each agent's `openclaw.json` has a per-channel `users` allowlist. If `bot_user_id` values weren't populated when the second render ran, peer bots are missing from the allowlist.

**Fix:**
1. Confirm `fleetmind slack discover` ran after `fleetmind secrets populate`
2. Re-run `fleetmind render fleet-<name>.yaml`
3. Re-run `fleetmind push fleet --fleet fleet-<name>.yaml --restart`

### Slack app installation fails / tokens rejected

**Symptom:** `fleetmind secrets populate` stores tokens but the gateway logs `invalid_auth`.

**Cause:** App was installed before setting the correct bot token scopes, or the wrong token type was stored (`xapp-` where `xoxb-` was expected or vice versa).

- `bot_token` → starts with `xoxb-` (from OAuth & Permissions → Bot User OAuth Token)
- `app_token` → starts with `xapp-` (from Basic Information → App-Level Tokens, with `connections:write` scope)

### `signing_secret` not required

Socket-mode setups (the default) do not use `signing_secret`. Leaving it empty or absent is correct.

### Single Terraform apply requires Slack channels to exist first

`fleetmind render` derives `wake_target_session_key` from the PM's first channel. If that channel ID is a placeholder or empty, the EventBridge task-ledger trigger will not have a valid target. Always create Slack apps and fill in channel IDs before running the first render and apply.

### Concurrent fleet pushes are not safe

Running `fleetmind push fleet` for two different fleets simultaneously against the same account is not safe today. Apply one fleet at a time (tracked in issue #69).

### `pull-self` errors: agent.env not found

**Symptom:** `ERROR: /etc/fleetmind/agent.env not found`.

**Cause:** The bootstrap script didn't complete, or the instance was replaced without reprovisioning.

**Fix:** Check EC2 console output for bootstrap errors. If the instance is healthy but the file is missing, bootstrap may have failed mid-run. Terminate and replace the instance (Terraform taint + apply) so bootstrap runs fresh.

### Bot EC2 not appearing in SSM

**Symptom:** `push fleet` reports "instance not in SSM" for an agent.

**Cause:** The SSM agent isn't running or hasn't registered yet. Common on new instances during the first few minutes.

**Fix:** Wait 2–3 minutes and retry. If the issue persists, SSM into the instance directly and check `sudo systemctl status amazon-ssm-agent`.
