# Module-level troubleshooting

IaC-side failures: state, locking, module-version drift, BYO VPC misconfiguration, taint/replace. Agent-runtime failures (Slack, push/pull-self, delegation) are covered in the agent runtime's own docs.

---

## Terraform state and locking

### `Error acquiring the state lock`

**Cause:** A previous run was killed (Ctrl+C, SSH disconnect, CI cancellation) before releasing the DynamoDB lock.

**Fix:** Confirm no one else is running Terraform in this workspace, then force-unlock using the lock ID from the error:

```bash
terraform force-unlock <LOCK_ID>
```

If the lock ID isn't shown, list the DDB table directly: `aws dynamodb scan --table-name <YOUR-LOCK-TABLE> --region <region>`.

### `terraform init` fails: lock table doesn't exist

**Cause:** The DynamoDB state-lock table is a one-time per-account setup (it can't be managed by the Terraform it locks).

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

### Concurrent fleet applies step on each other

**Symptom:** Running `terraform apply`/`fleetmind push fleet` for two different fleets from the same directory causes wrong-workspace/wrong-tfvars mistakes.

**Cause:** CLI workspaces hide the selected state namespace while fleet variables come from a separate `-var-file`, so it's easy to pair fleet A's vars with fleet B's workspace.

**Fix:** Use explicit backend `key` values per fleet (see below) — makes the state target visible in config/CI logs instead of depending on the selected workspace.

---

## Migrating from CLI workspaces to explicit backend keys

> Fleets onboarded with FleetMind CLI post-fleetmind#255 already default to an explicit `fleets/<fleet-name>/terraform.tfstate` key and don't need this. This is for fleets provisioned on a CLI workspace before that change.

A workspace's state is an S3 object at `env:/<workspace>/<key-path>` (or `env:/<workspace>/terraform.tfstate` if `key` was unset). Moving to an explicit key copies that object to a new key and points a fresh backend config at it — not destructive to infrastructure. Do one fleet at a time.

1. **Back up current state:**

   ```bash
   terraform workspace show
   terraform state pull > backup-<fleet>-$(date +%Y%m%d).tfstate
   ```

2. **Pull the fleet's workspace state:**

   ```bash
   terraform workspace select <fleet>
   terraform state pull > /tmp/<fleet>.tfstate
   ```

3. **Switch to `default` before reconfiguring the backend** (staying on `<fleet>` keeps the `env:/<fleet>/` prefix even with an explicit `key` set):

   ```bash
   terraform workspace select default
   ```

4. **Set the new explicit key** in your backend config, e.g.:

   ```hcl
   backend "s3" {
     bucket         = "my-fleet-tfstate"
     key            = "fleets/<fleet>/terraform.tfstate"
     region         = "us-west-2"
     dynamodb_table = "my-fleet-tfstate-lock"
     encrypt        = true
   }
   ```

   Don't apply yet.

5. **Re-init and push the saved state:**

   ```bash
   terraform init -reconfigure
   terraform state push /tmp/<fleet>.tfstate
   ```

   `state push` refuses to overwrite a different lineage/serial without `-force` — don't force unless the destination key is empty or is genuinely this fleet's prior state.

6. **Verify with a clean plan before touching real infrastructure:**

   ```bash
   terraform plan -var-file=workspaces/<fleet>.tfvars -var-file=workspaces/<fleet>.derived.tfvars
   ```

   Expect no changes; any diff means the migrated state doesn't match reality — compare against the step-1 backup.

7. **Clean up** once the plan is clean and you've done one successful apply against the new key:

   ```bash
   terraform workspace select default
   terraform workspace delete <fleet>
   ```

   (Refuses to remove a workspace with tracked resources — a safety check.)

If the module version also changed resource addresses (e.g. a renamed submodule), run `terraform state mv` *after* the backend migration, as a separate step:

```bash
terraform state mv 'module.old_address' 'module.new_address'
```

---

## Variable propagation

### `terraform apply` ignores `fleet_name` / `agent_names`

**Cause:** Forgot `.derived.tfvars` — not auto-loaded, must be passed explicitly (the `derived.tfvars` suffix, not `auto.tfvars`, prevents cross-workspace contamination).

**Fix:**

```bash
terraform apply \
  -var-file=workspaces/<fleet>.tfvars \
  -var-file=workspaces/<fleet>.derived.tfvars
```

If using `fleetmind-template`'s CI, check `.github/workflows/plan.yml` has both `-var-file` flags.

---

## Module-level resource recovery

### Replace a single agent EC2 (taint + apply)

**Symptom:** One agent's instance is in a bad state (half-completed bootstrap, missing `/etc/fleetmind/agent.env`, stuck SSM agent); other agents are healthy.

**Fix:** Taint just that agent's EC2 inside the `agent` submodule and re-apply:

```bash
terraform taint 'module.fleetmind.module.agent["<agent_id>"].aws_instance.agent'
terraform apply \
  -var-file=workspaces/<fleet>.tfvars \
  -var-file=workspaces/<fleet>.derived.tfvars
```

(`module.fleetmind` = outer module call; `module.agent["<agent_id>"]` = per-agent submodule instance; `aws_instance.agent` = EC2 resource.) Replacement gets a new instance ID; IAM role, SG, secrets preserved; bootstrap re-runs on first boot.

### Drift between `enable_interface_endpoints` and actual endpoints

**Symptom:** `enable_interface_endpoints = true` applied, but SSM traffic still goes via NAT (or private subnets have no internet and bots can't reach SSM).

**Cause:**

1. **BYO VPC mode** — the toggle is ignored when `var.vpc_id` is set (gated on `local.create_vpc`); see [`EXISTING-VPC.md`](./EXISTING-VPC.md).
2. **Endpoint creation failed silently** — check `terraform state list | grep endpoint` for `aws_vpc_endpoint` resources (`ssm`, `ssmmessages`, `ec2messages`, `secretsmanager`); missing ones mean the original apply hit a quota/permission issue.

**Fix for case 2:** `terraform apply -target='module.fleetmind.aws_vpc_endpoint.interface' -var-file=...`, then check the console for the failure.

---

## Delegation: terminal task events not reaching the PM

**Symptom:** Worker updates a task to `shipped` in DDB; PM never wakes; no errors in either gateway's log.

**Background:** Terminal task events reach the PM over **NATS push**. This module creates no SQS/EventBridge/SSM wake infrastructure.

Check instead (provisioned by `modules/agent/user_data/agent_bootstrap.sh.tpl`, STAGE 14, on the agent EC2s — not by this submodule):

```bash
# PM EC2: is the NATS subscriber unit up?
systemctl status "fleetmind-nats-<pm-agent-id>.service"
journalctl -u "fleetmind-nats-<pm-agent-id>.service" --no-pager -n 100

# Is NATS reachable from the bot host?
curl -fsS http://nats.<fleet-name>.internal:8222/healthz
```

Common causes: subscriber `.path` unit hasn't started its `.service` yet (needs `fleet.yaml` deployed via `fleetmind push`); NATS unreachable (check the `modules/nats/` EC2 and SG rules); or the worker never actually published a terminal status.

## `Secret <name> already scheduled for deletion` when re-creating a fleet

**Symptom:** Destroyed a fleet (`secret_recovery_window_days = 0`), then immediately re-applied with the same name; apply errors with this message.

**Cause:** Force-deletion (`recovery_window_in_days = 0`) propagates eventually-consistently in Secrets Manager — the re-apply's create collides with the still-propagating deletion. (Just *setting* `secret_recovery_window_days = 0` and re-applying without a destroy in between doesn't trigger this.)

**Fix:** Wait ~30 seconds between destroy and re-apply, or force-purge first:

```bash
aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery --region <region>
```

Then retry `terraform apply`.

---

## Related

- BYO VPC details: [`EXISTING-VPC.md`](./EXISTING-VPC.md)
- Standalone task-ledger consumption: [`TASK-LEDGER-STANDALONE.md`](./TASK-LEDGER-STANDALONE.md)
- Per-version upgrade notes: [`MIGRATIONS.md`](./MIGRATIONS.md)
