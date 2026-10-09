# Terraform migration notes

## Consolidation into FleetMind

The former `terraform-aws-fleetmind` source is maintained in this repository. The canonical operator configuration is `infra/terraform`; its embedded implementation is `infra/terraform/modules/fleetmind`.

Existing fleets must retain the wrapper module boundary:

```hcl
module "fleetmind" {
  source = "./modules/fleetmind"
  # existing inputs
}
```

That boundary preserves addresses such as `module.fleetmind.module.agent["worker"].aws_instance.agent`. Do not point an existing state directly at `modules/fleetmind`, since doing so removes `module.fleetmind` from every resource address.

Before applying a migrated configuration, initialize it against the existing backend and inspect the plan:

```bash
terraform -chdir=infra/terraform init -backend-config=backend.hcl
terraform -chdir=infra/terraform plan -var-file=workspaces/<fleet>.tfvars -var-file=workspaces/<fleet>.derived.tfvars
```

The plan must not show destroy/create operations caused solely by changed resource addresses. Consumer repositories should switch to a FleetMind release tag only after the consolidation release is published.

## Service-owned OpenClaw runtime

### Ownership modes

The default remains `root-managed`: bootstrap installs OpenClaw into the system npm prefix as root. The `openclaw` account owns state, plugins, and the custom `openclaw-<agent>.service` user unit, but cannot replace the core package.

Set this in `fleet.yaml` only when the agent should be allowed to use OpenClaw's supervised update path:

```yaml
openclaw:
  self_managed_updates:
    enabled: true
    channel: stable # stable | extended-stable | beta | dev
```

`fleetmind render` then emits `openclaw_runtime_mode = "self-managed"` into the derived tfvars and the selected `update.channel` into every generated `openclaw.json`. The channel is fleet-owned policy, so later pushes reconcile local channel drift. Self-managed provisioning rejects `latest`, dist-tags, and ranges: set `openclaw_version` in the operator-owned workspace tfvars to the exact version rehearsed on a disposable host.

Fresh self-managed hosts install that seed into `/home/openclaw/.local/share/fleetmind/openclaw-runtime`. Only that dedicated prefix is writable by `openclaw`; `/usr/lib/node_modules`, `/usr/local`, and the general user npm configuration remain unchanged. The gateway keeps its FleetMind unit name. OpenClaw owns the replaceable base service, including `OPENCLAW_SYSTEMD_UNIT` and native service markers. FleetMind owns a durable `50-fleetmind.conf` drop-in containing secret refresh, environment, config existence condition, logging and restart policy, but no launcher override. The dedicated `NPM_CONFIG_PREFIX` remains in runtime policy. Native update service refresh can replace the base without losing FleetMind policy.

Fresh bootstrap writes the selector, operator profile and policy drop-in, **not a placeholder gateway base**. The first `fleetmind pull-self --apply --restart --user-systemd` invokes the authoritative dedicated `gateway install --force` after validated config publication. This is deliberately deferred: the current native installer otherwise synthesizes a local config/token when config is absent. Later pushes restart a successfully activated existing service without reinstalling it. If native installation published the base but failed before daemon-reload/enable/restart completed, the next identical restart repairs that partial activation; a durable completion receipt or a fully healthy manager view prevents overwriting a runtime that later self-updated. The persistent account selector is authoritative for config validation even in sanitized SSM environments; SSM/operator entry points select the same launcher and fail closed if it is unavailable. State, config, workspace, and plugin paths do not move.

The pin has different ownership semantics in each mode:

- **root-managed:** `openclaw_version` is the infrastructure installation target.
- **self-managed:** `openclaw_version` is a fresh-host/replacement seed only. An ordinary apply does not reinstall or downgrade a host because agent `user_data` drift is ignored. OpenClaw owns later on-host versions through its supervised updater.
- **replacement:** changing `agent_rollout_trigger` creates a fresh host from the declared exact seed. Before a rollout, reconcile the seed to a release no older than the active state writer and rehearse it; replacement is not an implicit way to downgrade.

A channel does not apply updates by itself. `stable` resolves npm's stable/latest release only when an authorized OpenClaw update is explicitly started; `extended-stable`, `beta`, and `dev` retain their native OpenClaw meanings. FleetMind never substitutes `latest` during self-managed bootstrap.

### Disposable rehearsal and in-place migration

Rehearse this sequence on a disposable host before selecting a real canary:

1. Pin an exact `openclaw_version`, enable `self_managed_updates`, render, and inspect both workspace tfvars files.
2. Provision the disposable host and push its workspace. Verify the gateway unit still has the `openclaw-<agent>.service` identity, its launcher resolves under the dedicated prefix, and the generated config contains the intended `update.channel`.
3. Run OpenClaw's dry-run/status update checks, then one supervised update. Treat handoff acknowledgement as pending, not success; verify the terminal update record plus gateway health/version.
4. Exercise the rollback/recovery behavior against a verified state backup. Only then repeat on one production canary such as Wren.

Terraform intentionally does not retrofit existing instances because `user_data` changes are ignored. For an in-place host migration, first merge/release the FleetMind change, update `fleet.yaml`, render, and push so the live config already carries the selected channel. Copy both `migrate-openclaw-self-managed.sh` and its adjacent `openclaw_runtime_migration.py` from the **same FleetMind release tag** to one directory on the host, then run it as root through the authorized SSM/operator path:

```bash
infra/terraform/modules/fleetmind/modules/agent/scripts/migrate-openclaw-self-managed.sh \
  --agent-id <agent> \
  --version <exact-openclaw-version> \
  --channel <channel>
```

The shell helper immediately drops privilege to `openclaw` with a clean environment. No root process runs service-owned package code or writes through the runtime home. The unprivileged implementation rejects symlinked, foreign-owned or group/world-writable layouts. Historical root-owned intermediate directories require explicit operator inspection/repair first; the helper never recursively takes ownership.

Migration requires the requested release to match **both the effective canonical root-managed launcher and the authenticated running gateway version**. Existing custom drop-ins or unfamiliar launchers fail closed for operator reconciliation. Upgrade only after same-release ownership transfer through OpenClaw's supported updater. A different dedicated package is never overwritten.

A private account-owned journal and nonblocking lock serializes only migration/rollback peers. It is **not** an OpenClaw updater lock. OpenClaw's internal service-operation lock and managed-update lease have no supported external acquisition interface, and systemd exposes no compare-and-swap precondition spanning definition validation and replacement. Consequently the helper never invokes `gateway install`, reinstall, daemon-reload, or restart and never restores a native-owned service file. It stages the exact package, re-attests the live root gateway, uses the public `gateway stop --force`, and writes only FleetMind-owned policy/profile files. It then exits with the exact dedicated `gateway install --force` command. Establish exclusive operator maintenance quiescence, run that native command, and rerun the helper; the rerun adopts the result only after authenticated readiness, exact version/launcher, custom identity, disk-image, and loaded-manager verification. This explicit operator boundary is the supported ownership transition. The helper's checks before and after a write are detection, not an atomic exclusion guarantee; an independently started updater remains an operator-coordination error.

Before stop, the journal records the native service image, FleetMind-owned pre/postimages, both launcher attestations, and the live loaded-manager/process fingerprint. It compares that complete source fingerprint again immediately before the public stop. After stop it records the phase-normalized **loaded** manager fingerprint: service identity, `FragmentPath` and its file hash, normalized effective `ExecStart`, `DropInPaths` and every drop-in hash, `WorkingDirectory`, hashed allowlisted launch `Environment` values, `EnvironmentFiles` plus hashed allowlisted file inputs, `UnsetEnvironment`, `NeedDaemonReload`, `LoadState`, inactive-or-failed state, zero `MainPID` and `ControlPID`, and no `ControlGroup`. If interruption occurs inside the stop before that second record, recovery derives the same offline expectation from the pre-stop fingerprint. Recovery is admitted only while that definition, quiescence class, native image, launcher pair, and per-file FleetMind-owned source/target transition still match. Recovery restores only FleetMind-owned files; native base, backup, NATS base, and native environment files are excluded. It then exits with an operator-run target-launcher `gateway restart --preserve-definition` command and verifies the result on rerun. A native definition change that wins immediately before the FleetMind-owned restore is therefore preserved and detected before any restart; subsequent invocations refuse before another restore. Ambiguous manager state, an unjournaled native image, pending daemon reload, nonzero process/control state, or launcher drift fails closed without install, restore of native files, reload, or restart. Allowlisted values are stored only as hashes; credentials are neither stored nor compared. OpenClaw state/config/plugin data is never reverted or deleted.

### Rollback

Immediately after migration, before any self-update, the two launchers are the same version. The migration-only rollback is:

```bash
infra/terraform/modules/fleetmind/modules/agent/scripts/migrate-openclaw-self-managed.sh \
  --rollback --agent-id <agent>
```

The helper refuses this rollback when root-managed and self-managed versions differ, because swapping only the launcher after a state/schema migration can be an unsafe downgrade. It stops the exact self-managed gateway, restores only FleetMind-owned policy/profile files, and exits with the exact recorded root launcher `gateway install --force` command. Run that command only under exclusive operator maintenance quiescence, then rerun the helper to verify authenticated root readiness and close the rollback. The helper never overwrites the native base during rollback; a native definition change at the final FleetMind restore boundary is preserved and aborts before any install or restart request. Repeated successful migration/rollback requests are verified no-ops only when the recorded images, loaded definition/drop-ins, launcher fingerprint/version, selector, native identity, and dedicated prefix still match. Missing artifacts, extra drop-ins, same-version edits, or incomplete attestations fail closed. After a native update, use the native update/recovery workflow rather than treating the old ownership-transfer journal as a current attestation.

After any self-update, use OpenClaw's compatibility-checked update rollback/recovery and a verified pre-update state backup. If rollback is refused because state migrated, keep the newer compatible runtime and repair it; do not remove the drop-in or reinstall an older pin over live state. The helper intentionally refuses post-update launcher rollback even if a newer root package has since been installed: it restores only its recorded same-release snapshot. Returning to root management after an update is a separately rehearsed operator procedure; reconcile state compatibility, service ownership, and readiness before disabling the fleet's self-managed policy.

## Historical migrations

The former standalone repository contains migration guidance for releases predating this consolidation. Keep its historical material available while active consumers move to a released FleetMind source.
