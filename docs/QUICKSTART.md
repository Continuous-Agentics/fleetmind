# FleetMind Quickstart

This is the narrative happy-path for bringing up a working 2-bot fleet. First-time bring-up realistically takes *~20–30 minutes* end-to-end — of which roughly half is clicking through the Slack UI to create two apps and copy four tokens. Once Slack is set up and AWS bootstrap is done, the iteration loop drops to about a minute (`render` + `push fleet --restart`). The last step is *"DM your PM bot in Slack and ask it to delegate a task."*

If anything is unfamiliar, see [CONCEPTS.md](./CONCEPTS.md) for the vocabulary. For the comprehensive reference with every option, see [SETUP-A-FLEET.md](./SETUP-A-FLEET.md). When something breaks, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Prerequisites

This fast-path assumes you have:

- **fleetmind CLI** installed locally (`npm install -g @continuous-agentics/fleetmind` — see [README.md](../README.md) for the `~/.npmrc` PAT setup if `npm install` 404s)
- **AWS CLI v2** configured for your target account, with admin or equivalent permissions
- **Terraform ≥ 1.5** (`tfenv` works fine — `.terraform-version` is committed)
- **Slack workspace** admin access (you'll create apps and channels)
- **One-time AWS account setup done**: TF state S3 bucket, DynamoDB lock table, GitHub Packages PAT stored in SSM at `/fleetmind/shared/github-packages-token`. If not, jump to [§First-time setup](#first-time-setup-cold-start) at the bottom, then come back.

Target region for this walkthrough: `us-west-2`.

---

## 1. Scaffold the fleet (~30s)

```bash
fleetmind init --name acme --client "Acme Corp" --output fleet-acme.yaml
```

This writes `fleet-acme.yaml` in your current directory (default is `fleet.yaml` — the `--output` flag overrides it). Replace its `agents.list[]` with this minimal 2-bot definition:

```yaml
fleet:
  name: acme
  version: "1.0.0"
  client: "Acme Corp"

delegation:
  enabled: true
  aws_region: us-west-2
  table_name: acme-tasks         # matches Terraform default ${fleet_name}-tasks
  s3_bucket: acme-ledger         # matches Terraform default ${fleet_name}-ledger

agents:
  defaults:
    model: anthropic/claude-haiku-4-5
    workspace_base: /opt/openclaw/workspace
    plugins:
      - anthropic

  list:
    - id: pm
      name: Conductor
      emoji: 🎼
      role: pm
      orchestrator: true
      model: anthropic/claude-sonnet-4-6
      persona:
        soul: |
          You are Conductor, a PM bot. You receive tasks from humans, delegate
          to worker bots via the bot-delegation skill, track everything in a
          task ledger, and close the loop.
      slack:
        account_id: pm
        channels:
          - "C_HOME_CHANNEL_ID"        # PM's home channel — fill in after §3
          - "C_DELEGATION_CHANNEL_ID"  # delegation channel — fill in after §3
        bot_token: "${PM_BOT_TOKEN}"
        app_token: "${PM_APP_TOKEN}"
      skills:
        - name: bot-delegation
          source: fleetmind
      agent_to_agent:
        can_send_to: [worker]
      delegation:
        worker_bots: [worker]
        sweeps:
          - name: pm-sweep-worker
            worker_id: worker
            every: 5m
            model: anthropic/claude-haiku-4-5

    - id: worker
      name: Forge
      emoji: ⚙️
      role: backend-worker
      orchestrator: false
      persona:
        soul: |
          You are Forge, a worker bot. You accept delegated tasks from
          Conductor, acknowledge with :eyes:, ship the work, and report back.
      slack:
        account_id: worker
        channels:
          - "C_DELEGATION_CHANNEL_ID"  # same as PM's delegation channel
        bot_token: "${WORKER_BOT_TOKEN}"
        app_token: "${WORKER_APP_TOKEN}"
      skills:
        - name: bot-reception
          source: fleetmind
      agent_to_agent:
        can_send_to: [pm]
      delegation:
        specialty: backend

outputs:
  openclaw_json: ./rendered/openclaw-acme.json
  terraform_vars: ./infra/terraform/workspaces/acme.derived.tfvars

openclaw:
  gateway:
    port: 18789
    mode: local
    bind: loopback
  slack:
    mode: socket
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

Don't fill in `C_…_CHANNEL_ID` placeholders yet — you'll get them in §3.

## 2. Generate Slack app manifests (~10s)

```bash
fleetmind slack manifests --fleet fleet-acme.yaml --out ./rendered/slack-manifests/
```

Two files appear: `pm.yaml` and `worker.yaml`.

## 3. Create the Slack apps and channels (~5 min, manual UI)

This step is the longest because it's clicking through the Slack UI. Do it for **each agent** (`pm`, then `worker`):

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Choose your workspace, paste the YAML from `./rendered/slack-manifests/<agent>.yaml`
3. Click **Create** → **Install App** → **Allow**
4. From **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`)
5. From **Basic Information → App-Level Tokens**: **Generate Token and Scopes** with scope `connections:write`; copy the **App-Level Token** (`xapp-…`)

Then in your Slack workspace:

- Create `#acme-pm` (PM's home channel) and `#acme-delegation` (shared)
- `/invite @Conductor` to both channels
- `/invite @Forge` to `#acme-delegation` only
- Right-click each channel → **Copy link**. The channel ID is the `C…` segment at the end of the URL

Fill the channel IDs back into `fleet-acme.yaml`:

```yaml
# PM agent
slack:
  channels:
    - "CXXXXXXXXXX"   # #acme-pm
    - "CYYYYYYYYYY"   # #acme-delegation

# Worker agent
slack:
  channels:
    - "CYYYYYYYYYY"   # #acme-delegation only
```

> **Why now and not later:** `fleetmind render` derives `wake_target_session_key` from the PM's first channel ID. If the channel isn't filled in, the Terraform-managed EventBridge wake target won't work.

## 4. First render (~5s)

```bash
fleetmind render fleet-acme.yaml
```

Writes `./rendered/openclaw-acme.json` and `./infra/terraform/workspaces/acme.derived.tfvars`.

## 5. Write the infra-only tfvars (~30s)

Create `infra/terraform/workspaces/acme.tfvars`:

```hcl
aws_region    = "us-west-2"
instance_type = "t3.medium"

agent_ports = {
  pm     = 18789
  worker = 18790
}

openclaw_version  = "latest"
node_version      = "22"
fleetmind_version = "X.Y.Z"   # pin to current stable — `npm view @continuous-agentics/fleetmind version`

delegation_enabled = true
enable_rds         = false
enable_interface_endpoints = false
agent_instance_types = {}
```

## 6. Apply Terraform (~3 min)

```bash
cd infra/terraform
terraform workspace new acme || terraform workspace select acme
terraform apply \
  -var-file=workspaces/acme.tfvars \
  -var-file=workspaces/acme.derived.tfvars
```

Expect ~60–80 resources to add (VPC, NAT, EC2, IAM, SSM params, S3, DynamoDB, EventBridge). Confirm with `yes`. Wait for completion, then for EC2 bootstrap to finish (~3–5 min more — the instances run a multi-stage bootstrap script on first launch).

Check bootstrap completion:

```bash
INSTANCE_ID=$(terraform output -json instance_ids | jq -r '.pm')
aws ec2 get-console-output --instance-id "$INSTANCE_ID" --region us-west-2 \
  --query 'Output' --output text | tail -20
```

Look for `[bootstrap] Done. Agent pm provisioned.`.

## 7. Populate secrets (~1 min, interactive)

```bash
cd -    # back to your fleet.yaml dir
fleetmind secrets populate --fleet fleet-acme.yaml --interactive --region us-west-2
```

For each agent, paste the `xoxb-…` and `xapp-…` you copied in §3, plus your Anthropic API key. They're stored in AWS Secrets Manager under `/fleetmind/acme/agents/<agent>/…`.

## 8. Discover bot user IDs (~10s)

```bash
fleetmind slack discover --fleet fleet-acme.yaml --region us-west-2
```

Calls Slack's `auth.test` for each agent and writes `bot_user_id: U…` back into `fleet-acme.yaml`. Required for inter-bot message delivery (peers are added to per-channel allowlists by the next render).

## 9. Second render + push (~1 min)

```bash
fleetmind render fleet-acme.yaml
fleetmind push fleet --fleet fleet-acme.yaml --restart
```

The second render picks up the `bot_user_id`s; the push uploads workspaces to S3, triggers `pull-self --apply --restart` on each EC2 via SSM, and starts each agent's gateway for the first time.

## 10. Delegate a task in Slack 🎉

In Slack, DM Conductor in `#acme-pm`:

> Conductor, please delegate to Forge: write a haiku about distributed systems and post it back in the delegation thread.

Watch the round-trip:

1. Conductor creates a task ledger entry (DDB + S3) and posts a delegation envelope in `#acme-delegation` mentioning `@Forge`
2. Forge reacts `:eyes:` to acknowledge pickup
3. Forge ships the work and posts a completion summary in the thread
4. Forge's `shipped` state fires the [wake pipeline](./CONCEPTS.md#wake-pipeline); Conductor wakes and posts a closeout summary

You just delegated a task across two isolated EC2 hosts with a durable audit trail. ✨

---

## Day-to-day

After bring-up, the operator loop is short:

```bash
# Edit fleet.yaml or workspace files, then:
fleetmind push fleet --fleet fleet-acme.yaml --restart
```

See [OPERATING.md](./OPERATING.md) for the full operations reference (dry-run, single-agent push, manual `pull-self` from SSM session, restart semantics).

---

## First-time setup (cold start)

If `npm install -g @continuous-agentics/fleetmind` failed with 404, or you have no Terraform state bucket, or you've never used fleetmind in this AWS account, do these one-time steps first. They only need to happen once per account/operator.

### a. GitHub Packages PAT (per operator)

fleetmind is published to GitHub Packages as a private scoped package. Generate a classic PAT at [github.com/settings/tokens](https://github.com/settings/tokens) with `read:packages` scope, then:

```bash
echo "@continuous-agentics:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=<YOUR_PAT>" >> ~/.npmrc
npm install -g @continuous-agentics/fleetmind
```

### b. Store the PAT in SSM (one-time per AWS account)

EC2 instances also need a PAT during bootstrap to install fleetmind:

```bash
aws ssm put-parameter \
  --name /fleetmind/shared/github-packages-token \
  --type SecureString \
  --value <YOUR_PAT> \
  --region us-west-2
```

### c. Terraform state bucket + lock table (one-time per AWS account)

```bash
aws s3api create-bucket \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-bucket-versioning \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws dynamodb create-table \
  --table-name fleetmind-tf-state-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-2
```

### d. Terraform backend config (per operator clone)

```bash
cd infra/terraform
cp backend.example.hcl backend.hcl
$EDITOR backend.hcl   # fill in: bucket, region, dynamodb_table
terraform init -backend-config=backend.hcl
```

`backend.hcl` is gitignored.

Once these are done, return to [§1](#1-scaffold-the-fleet-30s) above. Subsequent fleets in the same account reuse all of this.

For the comprehensive bring-up reference (every variable, every gotcha, the full IAM model), see [SETUP-A-FLEET.md](./SETUP-A-FLEET.md).
