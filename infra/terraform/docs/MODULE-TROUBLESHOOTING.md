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

### Concurrent fleet applies break each other

**Symptom:** Running `terraform apply` (or `fleetmind push fleet`, which triggers it indirectly) for two different fleets simultaneously against the same AWS account causes intermittent failures — state lock contention, S3 race, SSM target confusion.

**Cause:** Workspaces auto-prefix state under `env:/<workspace>/` but share the lock table. Concurrent acquire-attempts on the same backend serialize, but a long-running apply blocks the other; if CI cancels the queued run, you can land in a half-applied state.

**Fix:** Serialize. Apply one fleet at a time. If you need to parallelize, use separate state buckets per fleet (configure via per-fleet `backend.hcl`).

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
