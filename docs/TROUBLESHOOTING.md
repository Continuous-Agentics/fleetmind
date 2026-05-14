# FleetMind Troubleshooting

Symptom → cause → fix, for the things that go wrong at 2am. Organized by category.

If a problem isn't listed here, [docs/SETUP-A-FLEET.md](./SETUP-A-FLEET.md) and [docs/OPERATING.md](./OPERATING.md) have deeper diagnostic detail, and [docs/integration/delegation.md](./integration/delegation.md) covers delegation-specific failures.

---

## Install & auth

### `npm install -g @continuous-agentics/fleetmind` returns 404

**Cause:** fleetmind is a private GitHub Packages scoped package. Without a `~/.npmrc` entry that points the `@continuous-agentics` scope at GitHub Packages and authenticates with a PAT, npm hits the public registry, doesn't find it, and 404s.

**Fix:**

```bash
# Generate a classic PAT at https://github.com/settings/tokens with read:packages scope
echo "@continuous-agentics:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=<YOUR_PAT>" >> ~/.npmrc
npm install -g @continuous-agentics/fleetmind
```

If you used a fine-grained PAT and it still fails, switch to a classic PAT — GitHub Packages does not support fine-grained PATs for `read:packages`.

### EC2 bootstrap fails to install fleetmind

**Symptom:** `aws ec2 get-console-output` shows `npm ERR! 404 Not Found - GET https://npm.pkg.github.com/@continuous-agentics%2ffleetmind`.

**Cause:** The PAT in SSM at `/fleetmind/shared/github-packages-token` is missing, expired, or lacks `read:packages` scope.

**Fix:**

```bash
aws ssm put-parameter \
  --name /fleetmind/shared/github-packages-token \
  --type SecureString \
  --value <NEW_PAT> \
  --region us-west-2 \
  --overwrite
```

Then terminate the failed instance (`terraform taint <resource>` + `terraform apply`) so it bootstraps fresh.

---

## Slack

### `fleetmind slack discover` fails for an agent

**Symptom:** `discover` errors with `not_authed`, `invalid_auth`, or `Token missing` for one or more agents.

**Cause:** Tokens haven't been written to Secrets Manager yet, or they're the wrong type. `discover` reads `bot_token` from Secrets Manager and calls `auth.test` — if no value is stored, the call errors.

**Fix:**

1. Confirm secrets exist:
   ```bash
   aws secretsmanager list-secrets --region us-west-2 \
     --query "SecretList[?contains(Name, 'fleetmind/<fleet>/agents/<agent>')].Name"
   ```
2. If missing, run `fleetmind secrets populate --fleet fleet-<name>.yaml --interactive --region us-west-2` first.
3. Retry `slack discover`.

### Bot logs `invalid_auth` after install

**Cause:** Wrong token type stored. The two Slack tokens look superficially similar but aren't interchangeable:

- `bot_token` → starts with `xoxb-` (from OAuth & Permissions → Bot User OAuth Token)
- `app_token` → starts with `xapp-` (from Basic Information → App-Level Tokens, with `connections:write` scope)

**Fix:** Re-run `fleetmind secrets populate --interactive` and paste the correct token shape when prompted. Then `fleetmind push fleet --restart` (or restart the affected gateway directly).

### `signing_secret not found` or "do I need signing_secret?"

**Cause:** None — you don't. Socket-mode setups (fleetmind's default) do not use `signing_secret`. The Slack app manifest includes the field, but it's only consumed in HTTPS-events mode, which fleetmind doesn't use.

**Fix:** Ignore. Leaving the field empty is correct.

### `fleetmind render` errors with empty `wake_target_session_key`

**Cause:** The PM's first Slack channel ID isn't filled in yet. `render` derives `wake_target_session_key` from `agents.list[<pm>].slack.channels[0]` — if that value is a placeholder like `"C_HOME_CHANNEL_ID"`, the EventBridge wake pipeline has no target.

**Fix:** Create the Slack apps and channels first, copy each channel ID from Slack's "Copy link" right-click menu (the `C…` segment at the end of the URL), and fill them into `fleet.yaml` before the first render. See [QUICKSTART.md §3](./QUICKSTART.md#3-create-the-slack-apps-and-channels-5-min-manual-ui).

### Inter-bot messages silently dropped

**Symptom:** PM posts a delegation envelope. Worker never reacts. No errors in either gateway's logs.

**Cause:** Each agent's `openclaw.json` has a per-channel `users` allowlist. If `bot_user_id` values weren't populated in `fleet.yaml` when the *second* render ran, peer bots aren't in the allowlist — incoming messages from them are filtered out at the gateway.

**Fix:**

1. Confirm `fleetmind slack discover` ran *after* `fleetmind secrets populate`.
2. Check `fleet.yaml` — each agent's `slack.bot_user_id` should be a `U…` string, not empty.
3. Re-render and re-push:
   ```bash
   fleetmind render fleet-<name>.yaml
   fleetmind push fleet --fleet fleet-<name>.yaml --restart
   ```

---

## Terraform

### `Error acquiring the state lock` / lock file recovery

**Symptom:** `terraform apply` hangs or errors with `Error acquiring the state lock` and a `Lock Info:` block citing a previous run.

**Cause:** A previous Terraform run was killed (Ctrl+C, SSH disconnect, CI cancellation) before it could release the DynamoDB lock.

**Fix:** Confirm no one else is currently running Terraform in this workspace. Then force-unlock with the lock ID from the error message:

```bash
terraform force-unlock <LOCK_ID>
```

If you don't see the lock ID, list the DDB table directly:

```bash
aws dynamodb scan --table-name fleetmind-tf-state-lock --region us-west-2
```

### `terraform init` fails: lock table doesn't exist

**Cause:** The DynamoDB state-lock table is a one-time per-account setup (chicken-and-egg: it can't be managed by the Terraform it locks).

**Fix:**

```bash
aws dynamodb create-table \
  --table-name fleetmind-tf-state-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-2
```

Then `terraform init -backend-config=backend.hcl`.

### `terraform apply` ignores `fleet_name` and `agent_names`

**Cause:** Forgot to pass `.derived.tfvars`. The `*.derived.tfvars` files are *not* auto-loaded by Terraform — they must be passed explicitly via `-var-file`. The intentional naming prevents cross-workspace contamination when multiple fleets share an account.

**Fix:** Always pass both files:

```bash
terraform apply \
  -var-file=workspaces/<fleet>.tfvars \
  -var-file=workspaces/<fleet>.derived.tfvars
```

### Concurrent fleet pushes break each other

**Symptom:** Running `fleetmind push fleet` for two different fleets simultaneously against the same AWS account causes intermittent failures (state lock contention, S3 race, SSM target confusion).

**Cause:** Not safe today — tracked in issue #69.

**Fix:** Serialize. Apply one fleet at a time.

---

## Deploy (push fleet / pull-self)

### Gateway won't start on first deploy

**Symptom:** `systemctl status openclaw-<agent>` shows `ConditionPathExists was not met`.

**Cause:** The `openclaw.json` config file doesn't exist yet in the workspace. The systemd unit has a condition guard that prevents startup until the workspace is populated. Bootstrap *does not* automatically run the first deploy.

**Fix:** Run `fleetmind push fleet --fleet fleet-<name>.yaml --restart`. The `--restart` flag is what triggers the first start — it's not automatic. The push ships the workspace (including `openclaw.json`) and then restarts the unit.

### Gateway won't restart after push (sudoers)

**Symptom:** `fleetmind pull-self --apply --restart` logs `sudo: a password is required` in SSM output. The workspace updates but the gateway keeps running the old code.

**Cause:** `pull-self --restart` shells out to `sudo systemctl restart openclaw-<agent_id>`. The `ec2-user` account doesn't have NOPASSWD sudo for that command.

**Fix:** On the EC2, add a sudoers entry (scoped to openclaw-prefixed units only — safe):

```
# /etc/sudoers.d/openclaw-restart
ec2-user ALL=(root) NOPASSWD: /bin/systemctl restart openclaw-*
```

The bootstrap script normally creates this. If it's missing, the instance bootstrap may have failed mid-run — see [`pull-self errors: agent.env not found`](#pull-self-errors-etcfleetmindagentenv-not-found).

### `pull-self` errors: `/etc/fleetmind/agent.env` not found

**Symptom:** Manual SSM session into the bot, `fleetmind pull-self` exits immediately with `ERROR: /etc/fleetmind/agent.env not found`.

**Cause:** The bootstrap script didn't complete, or the instance was replaced without reprovisioning. `agent.env` is written by bootstrap and contains `FLEET_NAME`, `AGENT_ID`, and `WORKSPACE_BASE`.

**Fix:** Check EC2 console output for bootstrap errors:

```bash
aws ec2 get-console-output --instance-id <i-id> --region us-west-2 --query 'Output' --output text | tail -50
```

If the instance is otherwise healthy but `agent.env` is missing, the cleanest recovery is to taint and re-apply so bootstrap runs fresh. From your fleet-template repo root:

```bash
terraform taint 'module.fleetmind.module.agent["<agent_id>"].aws_instance.agent'   # adjust to your module path
terraform apply -var-file=workspaces/<fleet>.tfvars -var-file=workspaces/<fleet>.derived.tfvars
```

### `push fleet` reports `instance not in SSM`

**Cause:** The agent's EC2 hasn't registered with SSM yet, or its SSM agent isn't running. The tarball still uploads to S3 — only the SSM-triggered apply is skipped.

**Fix:**

1. Wait 2–3 minutes — common on freshly-launched instances.
2. If still missing, SSM-session into the instance directly (or use EC2 Serial Console) and check:
   ```bash
   sudo systemctl status amazon-ssm-agent
   sudo systemctl restart amazon-ssm-agent   # if stopped
   ```
3. Confirm the instance's IAM role has `AmazonSSMManagedInstanceCore` attached (the Terraform module attaches this by default).
4. Re-run `fleetmind push fleet --fleet fleet-<name>.yaml --restart`.

### `openclaw.json` operator-patch handling and drift

**Symptom:** Somebody hand-edited `.openclaw/openclaw.json` on the EC2; subsequent `pull-self --apply` runs surprise people about whether the edit survives, gets overwritten, or interacts unexpectedly with the next `fleet.yaml`-driven render of the same key.

**Cause:** `pull-self` performs a **three-way merge** on `.openclaw/openclaw.json`:

```
merged = deepMerge(incoming, live − base)
```

where `incoming` is the freshly-rendered config from the tarball, `live` is the current on-disk config, and `base` is the snapshot of what fleetmind last rendered (`.openclaw/openclaw.base.json`). Operator patches applied via `openclaw config patch` (i.e. live keys that differ from base) are deliberately preserved on top of `incoming` on every push. When patches are preserved you'll see a dim log line in the `pull-self --apply` output:

```
ℹ live config patches preserved (see .openclaw/openclaw.base.json for base)
```

Hand-edits made directly to `openclaw.json` (without going through `openclaw config patch`) *are* picked up by the merge — because anything in `live` that differs from `base` is considered a patch — but they aren't tracked, so when the same key later changes in `fleet.yaml` and re-renders, you can get a confusing resolution.

**Fix:** For persistent local overrides, use `openclaw config patch` so the override is explicit and survives pushes cleanly. If you've already drifted via direct edits, the safest recovery is to translate the edit into either a `fleet.yaml` change (preferred) or an `openclaw config patch` invocation, then re-push:

```bash
fleetmind push fleet --fleet fleet-<name>.yaml --restart
```

To force an *incoming-wins* clean slate (destructive — drops every operator patch on this agent):

```bash
# On the bot via SSM session — remove the BASE, not the live config.
# With no base, pull-self's merge short-circuits and uses `incoming` as-is.
sudo rm /opt/openclaw/workspace/<agent_id>/.openclaw/openclaw.base.json
# Then from operator
fleetmind push fleet --fleet fleet-<name>.yaml --agent <agent_id> --restart
```

Note: removing `openclaw.json` itself (the *live* file) does **not** reset the merge — `pull-self` rebuilds it from `incoming` + the diff between `live` (which would now be missing) and `base`, which fails the existence check and falls back to `incoming` anyway, but you lose the patch audit trail in the process. Removing `openclaw.base.json` is the correct destructive lever.

### Old tarball still being applied after a push

**Cause:** `push fleet` overwrites `deploy-staging/<agent>.tar.gz` in S3 with the latest, but if the SSM trigger failed silently (offline instance) and you don't re-run push, the previous tarball stays. There's no version history in `deploy-staging/`.

**Fix:** Just re-run `fleetmind push fleet --restart`. It re-uploads (overwriting) and re-triggers `pull-self`. For audit purposes, the source of truth is git on `fleet.yaml` + rendered files in CI, not S3.

### `--no-apply` uploaded tarballs but nothing applied

**Cause:** Working as intended. `fleetmind push fleet --no-apply` skips the SSM trigger. Useful for pre-staging.

**Fix:** Run a no-flags `fleetmind push fleet` (or `pull-self --apply` directly via SSM) to apply.

---

## Delegation & task ledger

### `delegation is not enabled` from a `fleetmind task ...` command

**Cause:** Top-level `delegation.enabled: true` and `delegation.table_name` missing in `fleet.yaml`, or the wrong fleet file is being used.

**Fix:**

```yaml
delegation:
  enabled: true
  aws_region: us-west-2
  table_name: <fleet_name>-tasks
  s3_bucket: <fleet_name>-ledger
```

Or pass `--fleet <path>` explicitly if you have multiple fleet files.

### `ConditionalCheckFailedException` on `task ack` / `ship` / `block`

**Cause:** The task is in an unexpected state. Workers can only `ack` a `delegated` task they own; only `ship` an `accepted` task they own; only `block` `delegated|accepted`. The CLI uses conditional writes to enforce this per-row.

**Fix:**

```bash
fleetmind task get --task-id <hex>    # check current status + worker
```

Likely causes:

- Task already acked (status is `accepted`, not `delegated`) — call `ship` instead
- Wrong `--worker` value (must match the worker who was delegated to)
- Task already shipped/abandoned by another invocation

### `S3 write failed, fallback written locally`

**Cause:** S3 was unreachable (transient network blip, IAM hiccup, bucket policy denial) when the worker tried to write its narrative `.md`. The CLI falls back to writing the file to `~/.fleetmind/ledger-pending/` so the work isn't lost.

**Fix:** After S3 is healthy again, retry:

```bash
cat ~/.fleetmind/ledger-pending/<task-id>-shipped.md | fleetmind narrative put --task-id <task-id>
```

Then re-run the lifecycle transition (`fleetmind task ship --task-id <id>`).

### PM bot not waking on terminal events

**Cause:** Two wake paths exist. The fast path is event-driven (DDB Stream → EventBridge Pipe → SSM Run Command → `ddb-wake.sh` on PM). The resilience path is polling (PM bot's OpenClaw cron jobs sweep DDB).

**Fix:**

1. **DDB stream wake** (fast):
   - Check Pipe DLQ (`{prefix}ledger-pipe-dlq`) and wake DLQ (`{prefix}ledger-wake-dlq`) in the AWS console
   - Common causes: SSM `SendCommand` IAM perm missing, wrong tag value for instance targeting, session key not in `sessions.json` on the PM
2. **WORKER_SWEEP** (polling):
   - SSM into the PM instance
   - `openclaw cron list` — confirm sweep jobs exist
   - `openclaw cron runs --id <job-id> --limit 20` — check recent runs
   - If sweeps aren't registered, re-run `fleetmind deploy fleet-<name>.yaml`

### `WORKER_SWEEP jobs missing after gateway restart`

**Cause:** Sweep jobs live in `~/.openclaw/cron/jobs.json` on the PM. They survive gateway restarts. If they're gone, the file was deleted or corrupted.

**Fix:**

```bash
fleetmind deploy fleet-<name>.yaml
```

`deploy` idempotently re-seeds jobs from `fleet.yaml`'s `delegation.sweeps[]` into `jobs.json`. The gateway hot-reloads the file — no restart required.

### `task create` fails with "already exists"

**Cause:** Task ID collision (4 random bytes / 8 hex chars — collisions are rare but possible if you set the ID manually).

**Fix:** Regenerate the task ID (8 fresh hex chars) and retry. Don't hand-set IDs unless you really need to.

---

## Runtime / on-bot

### Bot's Slack identity disappears after a token rotation

**Cause:** Rotating the Slack bot token in the Slack UI breaks the running gateway's socket connection. The gateway loops trying the old token and fails.

**Fix:**

```bash
fleetmind secrets populate --fleet fleet-<name>.yaml --agent <id> --interactive --region us-west-2
fleetmind push fleet --fleet fleet-<name>.yaml --agent <id> --restart
```

The push re-pulls secrets at gateway startup.

### `gh-app-token` errors on the bot

**Symptom:** Running `gh-app-token` on the bot EC2 errors with `Could not load private key` or `JWT signing failed`.

**Cause:** GitHub App credentials missing or wrong in SSM under `/fleetmind/<fleet>/agents/<agent>/github-app/`.

**Fix:**

```bash
# Verify the SSM params exist
aws ssm get-parameter --name /fleetmind/<fleet>/agents/<agent>/github-app/app-id --region us-west-2
aws ssm get-parameter --name /fleetmind/<fleet>/agents/<agent>/github-app/installation-id --region us-west-2
aws ssm get-parameter --name /fleetmind/<fleet>/agents/<agent>/github-app/pem --with-decryption --region us-west-2
```

If any are missing or wrong, re-run `fleetmind github-app store` with the correct values. See [GITHUB-APPS.md](./GITHUB-APPS.md) for the full credential flow.

---

## Quick reference

```bash
# Inspect a bot from your laptop (SSM session)
INSTANCE_ID=$(aws ssm describe-instance-information \
  --filters "Key=tag:fleetmind:fleet_name,Values=<fleet>" \
            "Key=tag:fleetmind:agent_id,Values=<agent>" \
  --query 'InstanceInformationList[0].InstanceId' \
  --output text --region us-west-2)
aws ssm start-session --target "$INSTANCE_ID" --region us-west-2

# Once on the bot
sudo systemctl status openclaw-<agent> --no-pager -l
sudo journalctl -u openclaw-<agent> -n 100 --no-pager
fleetmind pull-self                  # show diff vs latest push
fleetmind pull-self --show-diffs     # per-file diff for modified text files
openclaw cron list                   # if PM bot — list sweep jobs

# Operator-side
fleetmind push fleet --dry-run                              # preview, no changes
fleetmind push fleet --fleet fleet-<n>.yaml --restart       # full apply
fleetmind push fleet --agent <id> --restart                 # single agent
fleetmind secrets populate --fleet fleet-<n>.yaml --interactive --region us-west-2
fleetmind slack discover --fleet fleet-<n>.yaml --region us-west-2
fleetmind render fleet-<n>.yaml
```
