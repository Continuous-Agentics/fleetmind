# FleetMind Operations Guide

This document covers day-to-day fleet management: deploying workspace updates, the
`fleetmind push fleet` / `fleetmind pull-self` workflow, IAM requirements, dry-run
patterns, and common gotchas.

---

## Overview: the deploy loop

FleetMind separates **fleet render** (operator laptop, git source of truth) from
**fleet apply** (each bot EC2, live workspace). The update workflow has two
complementary shapes:

| Shape | Who runs it | What it does |
|-------|-------------|--------------|
| `fleetmind push fleet` | Operator (laptop) | Render → package → upload to S3 → trigger each bot |
| `fleetmind pull-self` | Bot (EC2) | Pull from S3 → diff → apply |

`push fleet` calls `pull-self` automatically via SSM. You can also invoke `pull-self`
directly on a bot (SSH/SSM session) or trigger it from Slack ("Conductor, pull and restart").

---

## Operator IAM requirements

`push fleet` runs with your local AWS credentials. Your IAM principal needs:

### S3 (tarball + manifest upload)

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],
  "Resource": "arn:aws:s3:::<fleet-name>-ledger/deploy-staging/*"
}
```

You also need `s3:CreateBucket` + `s3:PutBucketVersioning` (or ask an admin to create
`<fleet-name>-ledger` in your target region before first use).

### SSM (instance lookup + command dispatch)

```json
{
  "Effect": "Allow",
  "Action": [
    "ssm:SendCommand",
    "ssm:DescribeInstanceInformation",
    "ssm:GetCommandInvocation"
  ],
  "Resource": "*"
}
```

Scope `SendCommand` to the specific instance ARNs for defense-in-depth:
```json
"Resource": [
  "arn:aws:ec2:us-west-2:ACCOUNT_ID:instance/i-CONDUCTOR_ID",
  "arn:aws:ec2:us-west-2:ACCOUNT_ID:instance/i-FORGE_ID"
]
```

### Note on bot IAM (nothing needed)

The bot IAM role does **not** need `ssm:SendCommand`. The bot side only needs S3 read
access to pull its own tarball — that's already granted by the bot's instance profile
(`s3:GetObject` on `<fleet-name>-ledger/deploy-staging/<agent_id>.*`).

---

## S3 bucket convention

Deploy artifacts live in `<fleet-name>-ledger` under the `deploy-staging/` prefix:

```
s3://gg-sandbox-ledger/deploy-staging/conductor.tar.gz
s3://gg-sandbox-ledger/deploy-staging/conductor.manifest.json
s3://gg-sandbox-ledger/deploy-staging/forge.tar.gz
s3://gg-sandbox-ledger/deploy-staging/forge.manifest.json
```

Create this bucket once:
```bash
aws s3 mb s3://gg-sandbox-ledger --region us-west-2
```

The bucket name is automatically derived from `fleet.name` in `fleet.yaml` — no
configuration needed.

---

## `fleetmind push fleet` — operator workflow

### Basic usage

```bash
# Preview what would be packaged (no upload, no SSM)
fleetmind push fleet --dry-run

# Full push: render → package → upload → trigger each bot
fleetmind push fleet

# Push and restart gateways after apply
fleetmind push fleet --restart

# Upload to S3 but don't trigger bots yet (inspect tarballs first)
fleetmind push fleet --no-apply

# Push only one agent
fleetmind push fleet --agent conductor

# Non-default fleet file or region
fleetmind push fleet --fleet path/to/fleet.yaml --region eu-west-1
```

### What it does, step by step

1. Runs `provisionFleet` + `writeOutputs` (same as `fleetmind deploy`) to render
   workspaces and per-agent `openclaw.json` into `./rendered/`.
2. For each target agent:
   - Assembles a staging directory: workspace files + `.openclaw/openclaw.json`.
   - Computes a sha256 manifest of every file (path, size, hash, mode).
   - Creates `<agent>.tar.gz` (all files relative to workspace root).
   - Uploads tarball + manifest to S3 `deploy-staging/`.
   - Sends an SSM run-shell-script command to trigger `fleetmind pull-self --apply`
     on the agent's EC2 instance (looked up by `fleet_name` + `agent_id` tags).
3. Prints a summary with SSM command IDs for follow-up.

### Checking SSM command output

```bash
# From the push summary, grab the command ID and instance ID
aws ssm get-command-invocation \
  --command-id <cmd-id> \
  --instance-id <instance-id> \
  --region us-west-2 \
  --query 'StandardOutputContent' \
  --output text
```

### Instance discovery

`push fleet` looks up each agent's EC2 instance via SSM's
`DescribeInstanceInformation` API using tag filters:
- `fleet_name = <fleet.name>`
- `agent_id = <agent.id>`

These tags are set by FleetMind's Terraform module. If an instance isn't registered
in SSM (offline, bootstrapping, SSM agent not running), the agent is skipped and the
push summary notes "instance not in SSM" — the tarball is still uploaded to S3.

---

## `fleetmind pull-self` — bot-side workflow

### Basic usage (run on the bot EC2 via SSM or SSH)

```bash
# Show diff against latest S3 deploy-staging (no apply)
fleetmind pull-self

# Same but fetch full per-file diffs for modified text files
fleetmind pull-self --show-diffs

# Apply changes (equivalent to git pull + apply)
fleetmind pull-self --apply

# Apply and restart gateway
fleetmind pull-self --apply --restart

# Dry-run: fetch + diff, no extraction or apply
fleetmind pull-self --dry-run

# Force apply even if workspace matches latest
fleetmind pull-self --apply --force
```

### Via SSM from your laptop

```bash
INSTANCE_ID=$(aws ssm describe-instance-information \
  --filters Key=tag:fleet_name,Values=gg-sandbox Key=tag:agent_id,Values=conductor \
  --query 'InstanceInformationList[0].InstanceId' --output text --region us-west-2)

aws ssm send-command \
  --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -u ec2-user fleetmind pull-self --apply --region us-west-2"]' \
  --region us-west-2 \
  --query 'Command.CommandId' --output text
```

### What it does, step by step

1. Reads `/etc/fleetmind/agent.env` for `FLEET_NAME`, `AGENT_ID`, and `WORKSPACE_BASE`.
2. Computes sha256 manifest of the live workspace (`$WORKSPACE_BASE/$AGENT_ID/`).
3. Downloads `<agent>.manifest.json` from S3 `deploy-staging/`.
4. Computes diff (added / modified / deleted).
5. Prints the diff. If no `--apply`: stops here.
6. If `--apply`: downloads tarball, verifies sha256, extracts to staging, applies diff
   atomically (`.new` → `rename`), cleans up.
7. If `--restart`: `sudo systemctl restart openclaw-<agent_id>`.

### Agent environment file

The bot reads `/etc/fleetmind/agent.env`:
```bash
FLEET_NAME=gg-sandbox
AGENT_ID=conductor
WORKSPACE_BASE=/opt/openclaw/workspace   # optional, defaults to /opt/openclaw/workspace
```

This file is written by the bootstrap script during instance launch. If it's missing,
`pull-self` will error with a clear message.

---

## Diff format

`pull-self` shows a structured diff before applying:

```
Fleet update for conductor:
  Added:    skills/new-skill/SKILL.md  (1.2 KB)
            skills/new-skill/README.md  (0.8 KB)
  Modified: AGENTS.md                   (was 4.1 KB, now 4.6 KB)
            .openclaw/openclaw.json    (was 3.2 KB, now 3.3 KB)
  Deleted:  skills/old-skill/           (entire dir, 12 files)
            stale-notes.md             (2.1 KB)

Summary: 2 added, 2 modified, 13 deleted (1 dir removal).

Apply with: fleetmind pull-self --apply [--restart]
```

**Entire-dir removal detection:** when all files under a directory are deleted in the
same update, the diff groups them as "entire dir, N files" rather than listing each
file individually.

Use `--show-diffs` for inline unified-style diffs of modified text files (capped at
50 lines per file):
```bash
fleetmind pull-self --show-diffs
```

---

## Restart behavior and sudo

`pull-self --restart` runs:
```bash
sudo systemctl restart openclaw-<agent_id>
```

The `ec2-user` account must be able to sudo this command. Two common approaches:

**Option A (recommended): sudoers entry**
```
# /etc/sudoers.d/openclaw-restart
ec2-user ALL=(root) NOPASSWD: /bin/systemctl restart openclaw-*
```

This is safe because it only allows restarting openclaw-prefixed units.

**Option B: operator-driven**
Don't pass `--restart` to `pull-self`. After `push fleet` completes and bots have
applied, manually restart each gateway:
```bash
aws ssm send-command \
  --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart openclaw-conductor"]' \
  --region us-west-2
```

---

## Manifest format

Every push produces an `<agent>.manifest.json` alongside the tarball:

```json
{
  "agent_id": "conductor",
  "fleet_name": "gg-sandbox",
  "fleetmind_version": "0.4.1",
  "rendered_at": "2026-05-12T21:30:00Z",
  "tarball": {
    "filename": "conductor.tar.gz",
    "size_bytes": 92348,
    "sha256": "abc123..."
  },
  "files": [
    { "path": "AGENTS.md", "size": 4612, "sha256": "xyz...", "mode": 644 },
    { "path": ".openclaw/openclaw.json", "size": 3284, "sha256": "abc...", "mode": 644 }
  ]
}
```

`files` is the authoritative source for diffing — `pull-self` diffs against this list,
not the tarball contents. `tarball.sha256` is verified before extraction to guard
against partial uploads.

---

## Atomicity guarantees

- **Modified files** are written to `<dest>.new` then `mv -f` to `<dest>` — kernel
  atomic on POSIX filesystems. The live workspace never sees a half-written file.
- **`.openclaw/openclaw.json`** is an exception: written directly (no `.new` rename)
  because OpenClaw's config reload handles partial writes defensively.
- **Added files** are simply `cp` (no prior version to worry about).
- **Deleted files** are `unlink` followed by empty-parent-dir cleanup.
- **No rollback**: if the apply exits mid-way (e.g., disk full), some files will be
  updated and others not. Run `fleetmind pull-self --apply --force` to re-apply.

---

## Gotchas

### 1. `--no-apply` still uploads

`fleetmind push fleet --no-apply` uploads tarballs and manifests to S3, but **skips**
the SSM trigger. This is useful when you want to pre-stage artifacts and trigger bots
manually later. The tarballs remain in `deploy-staging/` until overwritten by the next
push.

### 2. SSM offline agents

If a bot's EC2 instance is not registered in SSM at push time, the tarball is still
uploaded to S3 but the SSM trigger is skipped. When the instance comes back online, run
`pull-self` manually (or re-run `push fleet` to re-trigger).

### 3. Workspace ownership

`pull-self` runs as `ec2-user` and writes to `/opt/openclaw/workspace/<agent_id>/`.
The workspace directory must be owned by `ec2-user`. The bootstrap script handles this;
if you manually create workspace files, `chown -R ec2-user:ec2-user` them.

### 4. Old tarballs stay in S3

`push fleet` always overwrites `deploy-staging/<agent>.tar.gz` with the latest. There
is no versioned history in `deploy-staging/` — each push replaces the previous.
For audit purposes, check git history on `fleet.yaml` + rendered files in your CI.

### 5. `--show-diffs` capped at 50 lines/file

`pull-self --show-diffs` shows a simple line-by-line diff of modified text files, capped
at 50 lines per file. Binary files and unreadable files are skipped. This is a
first-pass view; for a full diff, check git on the source repo.

---

## Quick reference

```bash
# Operator (from laptop)
fleetmind push fleet --dry-run          # preview, no changes
fleetmind push fleet                     # push all agents
fleetmind push fleet --agent conductor  # push one agent
fleetmind push fleet --no-apply         # upload only, skip SSM
fleetmind push fleet --restart          # push + restart gateways

# Bot (from EC2 via SSM or SSH)
fleetmind pull-self                     # show diff, no apply
fleetmind pull-self --apply             # apply changes
fleetmind pull-self --apply --restart   # apply + restart
fleetmind pull-self --dry-run           # show diff (no extract)
fleetmind pull-self --show-diffs        # show per-file diffs

# Check SSM command output
aws ssm get-command-invocation \
  --command-id <id> --instance-id <id> --region us-west-2

# Manually trigger pull-self via SSM
aws ssm send-command \
  --instance-ids <id> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -u ec2-user fleetmind pull-self --apply --region us-west-2"]' \
  --region us-west-2

# Create deploy-staging bucket (one-time)
aws s3 mb s3://<fleet-name>-ledger --region us-west-2
```
