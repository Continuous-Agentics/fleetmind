# Module-level troubleshooting

IaC-side failures: Terraform state, locking, module-version drift, BYO VPC misconfiguration, taint/replace recovery. For agent-runtime failures (Slack, push/pull-self, delegation), see the corresponding troubleshooting in the agent runtime's docs.

---

## Terraform state and locking

### `Error acquiring the state lock` / lock file recovery

**Symptom:** `terraform apply` hangs or errors with `Error acquiring the state lock` and a `Lock Info:` block citing a previous run.

**Cause:** A previous Terraform run was killed (Ctrl+C, SSH disconnect, CI cancellation) before it could release the DynamoDB lock.

**Fix:** Confirm no one else is currently running Terraform in this workspace. Then force-unlock with the lock ID from the error message:

```bash
terraform force-unlock <LOCK_ID>
```

If you don't see the lock ID, list the DDB table directly:

```bash
aws dynamodb scan --table-name <YOUR-LOCK-TABLE> --region <region>
```

---

### `terraform init` fails: lock table doesn't exist

**Cause:** The DynamoDB state-lock table is a one-time per-account setup (chicken-and-egg: it can't be managed by the Terraform it locks).

**Fix:**

```bash
aws dynamodb create-table \
  --table-name <YOUR-LOCK-TABLE> \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region <region>
```

Then `terraform init -backend-config=backend.hcl`.

---

### Concurrent fleet applies step on each other

**Symptom:** Running `terraform apply` (or `fleetmind push fleet`, which triggers it indirectly) for two different fleets from the same working directory causes intermittent operator mistakes — wrong selected workspace, wrong tfvars pairing, or SSM/S3 actions aimed at a different fleet than intended.

**Cause:** CLI workspaces hide the selected state namespace in local Terraform state (`terraform workspace show`) while fleet-specific variables are supplied separately via `-var-file`. That split makes it easy for a local shell or CI job to pair fleet A's variables with fleet B's selected workspace.

**Fix:** Prefer explicit backend `key` values per fleet, as described in ["Migrating from CLI workspaces to explicit backend keys"](#migrating-from-cli-workspaces-to-explicit-backend-keys) below. Explicit keys don't replace normal state locking, but they make the state target visible in backend config/CI logs and remove reliance on the operator's currently selected workspace.

---

## Migrating from CLI workspaces to explicit backend keys

> **New fleets:** the FleetMind CLI's `fleetmind onboard` no longer runs
> `terraform workspace select`/`terraform workspace new` (fleetmind#255) —
> fleets onboarded with that CLI version or newer default to an explicit
> `fleets/<fleet-name>/terraform.tfstate` backend key from the start and
> never need this migration. This section is only for fleets that were
> already provisioned on a CLI workspace before that change.

**Symptom:** You have one or more fleets on CLI workspaces (state under `env:/<workspace>/...` in the shared state bucket) and want to move to the recommended explicit-`key` pattern (see [README.md § Consumer setup](../README.md#consumer-setup)) without downtime or state loss.

**Background:** A workspace's state is just an S3 object at `env:/<workspace>/<original-key-path>` (or `env:/<workspace>/terraform.tfstate` if `key` was unset, which is the common case for workspace-based fleets). Moving to an explicit key means copying that state object to a new key and pointing a fresh backend config at it — no resources are touched, so this is not destructive to your infrastructure. Do this per fleet, one at a time.

**Fix:**

1. **Confirm which workspace you're on and back up its state:**

   ```bash
   terraform workspace show
   terraform state pull > backup-<fleet>-$(date +%Y%m%d).tfstate
   ```

   Keep this backup until you've verified the migration (step 5).

2. **Pull the fleet workspace state to a local handoff file:**

   ```bash
   terraform workspace select <fleet>
   terraform state pull > /tmp/<fleet>.tfstate
   ```

   This captures the state object from the workspace-prefixed backend path (for example `env:/<fleet>/...`).

3. **Switch to the `default` workspace before reconfiguring the backend:**

   ```bash
   terraform workspace select default
   ```

   This step matters: if you stay on `<fleet>`, Terraform will keep applying the `env:/<fleet>/` workspace prefix even after you configure an explicit `key`.

4. **Decide the new explicit key** and update your backend config (or per-fleet root module) to use it, for example:

   ```hcl
   backend "s3" {
     bucket         = "my-fleet-tfstate"
     key            = "fleets/<fleet>/terraform.tfstate"
     region         = "us-west-2"
     dynamodb_table = "my-fleet-tfstate-lock"
     encrypt        = true
   }
   ```

   Don't apply yet — you're just changing config.

5. **Re-initialize against the new key and push the saved state:**

   ```bash
   terraform init -reconfigure
   terraform state push /tmp/<fleet>.tfstate
   ```

   `state push` refuses to overwrite a state with a different lineage/serial without `-force`; don't pass `-force` unless you've confirmed the destination key is empty or is genuinely this fleet's prior state — forcing over the wrong key can silently strand or corrupt another fleet's state.

6. **Verify before touching real infrastructure:**

   ```bash
   terraform plan -var-file=workspaces/<fleet>.tfvars -var-file=workspaces/<fleet>.derived.tfvars
   ```

   Expect **no changes**. Any diff here means the migrated state doesn't match what you think it does — stop and compare against the backup from step 1 rather than applying.

7. **Clean up the old workspace** once the plan is clean and you've run at least one successful apply cycle against the new key:

   ```bash
   terraform workspace select default
   terraform workspace delete <fleet>
   ```

   `terraform workspace delete` refuses to remove a workspace with resources still tracked in its state, which is a useful safety check — by this point the old workspace's state should already be empty of that fleet (the state now lives under the new key, not deleted, just relocated).

**If the module version also changed resource addresses** (e.g. a submodule was renamed) as part of this migration, use `terraform state mv` *after* the backend migration, against the new key, the same way you would for any other refactor:

```bash
terraform state mv 'module.old_address' 'module.new_address'
```

Moving addresses and migrating backends are independent operations — don't combine them in one step, so a mistake in one doesn't mask a mistake in the other.

---

## Variable propagation

### `terraform apply` ignores `fleet_name` / `agent_names`

**Cause:** Forgot to pass `.derived.tfvars`. The `*.derived.tfvars` files are *not* auto-loaded by Terraform — they must be passed explicitly via `-var-file`. The intentional naming (suffix `derived.tfvars` rather than `auto.tfvars`) prevents cross-workspace contamination when multiple fleets share an account.

**Fix:** Always pass both files:

```bash
terraform apply \
  -var-file=workspaces/<fleet>.tfvars \
  -var-file=workspaces/<fleet>.derived.tfvars
```

If you're using `fleetmind-template`'s CI, both `-var-file` flags should already be in `.github/workflows/plan.yml` — check there if `terraform plan` succeeds in CI but `fleet_name` is empty.

---

## Module-level resource recovery

### Replace a single agent EC2 (taint + apply)

**Symptom:** One agent's EC2 instance is in a bad state (bootstrap half-completed, `/etc/fleetmind/agent.env` missing, SSM agent stuck). The other agents are healthy and you don't want to disturb them.

**Fix:** Taint just the misbehaving agent's EC2 inside the `agent` submodule and re-apply:

```bash
terraform taint 'module.fleetmind.module.agent["<agent_id>"].aws_instance.agent'
terraform apply \
  -var-file=workspaces/<fleet>.tfvars \
  -var-file=workspaces/<fleet>.derived.tfvars
```

The `module.fleetmind` prefix is the operator's outer module call (the `module "fleetmind"` block in `main.tf`). Inside, `module.agent["<agent_id>"]` is the per-agent submodule instance (keyed by agent id). The EC2 resource is `aws_instance.agent`.

The replacement EC2 gets a new instance ID; IAM role, security group, and Secrets Manager state are preserved. Bootstrap re-runs on first boot.

---

### Drift between `enable_interface_endpoints` and actual endpoints

**Symptom:** You set `enable_interface_endpoints = true` in `workspaces/<fleet>.tfvars`, applied, and SSM session-manager calls still go via NAT (or your private subnets have no internet at all and the bots can't talk to SSM).

**Cause:** Two possible:
1. **BYO VPC mode.** The `enable_interface_endpoints` toggle is currently ignored when `var.vpc_id` is set (gated on `local.create_vpc`). See [`EXISTING-VPC.md`](./EXISTING-VPC.md) for the workaround.
2. **Endpoint creation failed silently.** Check `terraform state list | grep endpoint` — there should be `aws_vpc_endpoint` resources for `ssm`, `ssmmessages`, `ec2messages`, `secretsmanager`. If any are missing, the original apply hit a quota or permission issue.

**Fix for case 2:** `terraform apply -target='module.fleetmind.aws_vpc_endpoint.interface' -var-file=...` to re-attempt only the endpoint resources, then check the AWS console for what failed.

---

## Delegation: terminal task events not reaching the PM

### PM never wakes on a terminal task status

**Symptom:** Worker bot updates a task to `shipped` in DDB; PM bot never wakes; no errors in either gateway's log.

**Background:** Terminal task events are delivered to the PM over **NATS push**, not the old EventBridge Pipe -> SSM Run Command wake pipeline. That pipeline (and its `ledger-pipe-dlq` / `ledger-wake-dlq` queues and CloudWatch alarms) was removed. This module no longer creates any SQS/EventBridge/SSM wake infrastructure, so there are no DLQs to inspect here.

**Where to look instead** (these live on the agent EC2s, provisioned by `modules/agent/user_data/agent_bootstrap.sh.tpl`, STAGE 14, not by this submodule):

```bash
# On the PM EC2: is the NATS subscriber unit up?
systemctl status "fleetmind-nats-<pm-agent-id>.service"
journalctl -u "fleetmind-nats-<pm-agent-id>.service" --no-pager -n 100

# Is the NATS server reachable from the bot host?
curl -fsS http://nats.<fleet-name>.internal:8222/healthz
```

Common causes:
- *Subscriber unit not running:* the `.path` unit only starts the `.service` once `fleet.yaml` is present in the workspace. Confirm `fleetmind push` has deployed `fleet.yaml`.
- *NATS unreachable:* check the NATS server EC2 (`modules/nats/`) and the security group rules between bot hosts and the NATS host.
- *Worker never published:* confirm the worker's run actually wrote a terminal status and that its own `--mode worker` subscriber is healthy.

---

### `Secret <name> already scheduled for deletion` when re-creating a fleet

**Symptom:** You destroyed a fleet (with `secret_recovery_window_days = 0` in tfvars), then immediately re-applied to create a fleet with the same name. The second apply errors with `Secret <name> already scheduled for deletion`.

**Cause:** AWS Secrets Manager force-deletion (`recovery_window_in_days = 0`) propagates eventually-consistently. Your `terraform destroy` issued the force-delete; the secret is being torn down server-side; your follow-up apply tries to create a new secret with the same name and collides with the still-propagating deletion.

Note: just *setting* `secret_recovery_window_days = 0` in tfvars and re-applying (without a destroy in between) doesn't trigger this — the value is just updated on the in-state resource. The collision requires a destroy + immediate re-create cycle.

**Fix:** Either wait ~30 seconds between destroy and re-apply (the deletion usually propagates within that window), or force-purge the orphaned secret before re-applying:

```bash
aws secretsmanager delete-secret \
  --secret-id <name> \
  --force-delete-without-recovery \
  --region <region>
```

Then retry `terraform apply`.

---

## Related

- BYO VPC details: [`EXISTING-VPC.md`](./EXISTING-VPC.md)
- Standalone task-ledger consumption: [`TASK-LEDGER-STANDALONE.md`](./TASK-LEDGER-STANDALONE.md)
- Per-version upgrade notes: [`MIGRATIONS.md`](./MIGRATIONS.md)
