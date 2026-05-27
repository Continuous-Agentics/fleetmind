# Design — Deploy Transport (S3 + SSM)

> **Status:** SUPERSEDED 2026-05-27 by the provider-refactor direction.
> The original 2026-05-08 decision-record (named SSM document) is retained
> below for history; see "Reconciliation" for what actually shipped and why.
> **Implements:** target shape for `fleetmind deploy` and `fleetmind push`

## Reconciliation (2026-05-27) — generic command runner

The implementation diverged from the 2026-05-08 decision, and the divergence
is the better architecture for the multi-backend direction (AWS EC2 + Mac mini
+ VMware), so we ratify it rather than "fix" it.

**Decided:** deploy uses a *smart host, thin command* model. The host has the
`fleetmind` CLI installed; the transport's only job is to run a fixed command
(`fleetmind pull-self --apply`) on the resolved host. The apply logic
(download → merge → restart) lives once, in the CLI, not in a per-transport
script. This is expressed as a provider-neutral `CommandRunner`:

```
CommandRunner.run(host, ["fleetmind pull-self --apply"])
  ├─ aws-ssm → SSM SendCommand (AWS-RunShellScript)
  ├─ ssh     → ssh host 'fleetmind pull-self --apply'
  └─ local   → exec fleetmind pull-self --apply
```

paired with a provider-neutral `ArtifactStore` (the bundle's home) and a
`ServiceManager` (systemd / launchd / none). Config: step-1's
`deploy.artifact_store` block (s3 | local-fs | scp), *not* the
`deploy: {transport, staging, ssm}` block sketched at the bottom of this doc.

**Retired:** the named SSM document (`FleetMindDeployApply`) as the core
mechanism. It is AWS-locked (SSM documents don't exist on a Mac mini) and would
force the apply logic to be re-implemented per transport. The one property it
bought — a `SendCommand` caller can't run arbitrary commands — is AWS-only
defense-in-depth and can be reintroduced later as an *aws-ssm adapter detail*
(a TF-managed document that runs only the fixed `pull-self`) without changing
the `CommandRunner` interface. Not built now; revisit if a security review asks.

**Also note:** content-addressed `<fleet>/<sha>/<agent>.tar.gz` keys were not
adopted; the shipped scheme is flat `deploy-staging/<agent>.tar.gz` + timestamped
`history/<agent>/`, centralized in `src/deploy/plan.ts`.

---

> The remainder of this document is the original 2026-05-08 record, kept for
> historical context. Where it conflicts with the reconciliation above, the
> reconciliation wins.

> **Originally approved:** 2026-05-08 (decision-record)
> **Affects:** `src/runtime/provisioner.ts`, new `src/runtime/transport/`,
> new `infra/terraform/modules/deploy-staging/`, new SSM document module,
> openclaw-terraform tagging contract

## Problem

Today `fleetmind deploy` writes workspaces to the *local* filesystem at
`workspace_base`. That worked when fleetmind was a single-process toy on
the same host as the gateway, but the production shape is **one EC2 per
agent, one OpenClaw gateway per EC2** (see [`openclaw/INTEGRATION.md`](../../openclaw/INTEGRATION.md)).

There is no mechanism today to get rendered workspaces from the operator's
laptop (or CI) onto the right EC2 host. Operators currently work around
this with manual `git clone` + cron pulls on each host — a pattern that
predates fleetmind and isn't fleetmind's job to inherit.

We need a transport. This document records the chosen design.

## Decision

**S3 staging + named SSM Run Document trigger.**

```
operator laptop / CI
        │
        │  fleetmind deploy
        ▼
┌──────────────────────────────────────────────────────────┐
│  fleetmind                                               │
│  1. render workspaces locally (already works)            │
│  2. tar + upload to staging S3 bucket                    │
│     s3://<fleet>-deploy-staging/<sha>/<agent_id>.tar.gz  │
│  3. for each agent, SSM SendCommand by tag               │
│     fleetmind:agent_id=<id>                              │
│     invoking the named document FleetMindDeployApply     │
│     with parameters: { sha, agent_id, fleet_name }       │
│  4. poll command status; report per-agent success/fail   │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
   each agent's EC2 (running SSM agent)
       │
       │  document FleetMindDeployApply runs:
       ▼
   1. as root: aws s3 cp s3://.../<sha>/<id>.tar.gz /tmp/...
   2. as root: tar xzf to <workspace_base>/workspace-<id>/
   3. as root: chown -R openclaw:openclaw <workspace>
   4. as root: systemctl restart openclaw-gateway
```

## Why this shape

| Decision | Rationale |
|---|---|
| S3 for transport | SSM Run Command output cap (~48 KB) and sync timeout (~15s) make it bad for shipping tarballs. S3 is the obvious staging area; we already use it for the task ledger. |
| SSM for trigger | Same primitive the wake pipeline uses. No SSH key management, IAM-scoped, audited via CloudTrail, works through private subnets without bastion. Agent EC2s already have the SSM agent installed. |
| Named SSM Document (vs `AWS-RunShellScript`) | Operator can't pass arbitrary commands; only the approved document runs. Document content is in Terraform — version-controlled, reviewable. CloudTrail shows which document version executed. Same pattern as the existing wake pipeline. |
| Fleetmind-managed staging bucket | A new TF module under `infra/terraform/modules/deploy-staging/` matches the existing precedent (`context-store/`, `task-ledger/`). Operators apply once, fleetmind reads the bucket name from a `deploy:` block in fleet.yaml. Alternative — bring-your-own-bucket — has fewer abstractions but more setup friction. |
| Tag-based EC2 targeting | openclaw-terraform tags each agent's EC2 with `fleetmind:agent_id=<id>`. fleetmind queries by tag at deploy time. Same pattern as the wake pipeline's targeting; no separate registry needed. |
| Versioned tarballs from day one | `s3://<bucket>/<fleet>/<sha>/<agent_id>.tar.gz` — addressable, lets `fleetmind rollback <sha>` reuse the same SSM trigger with a different `sha` parameter. Trivial to add now; awkward to retrofit later. |

## Alternatives considered

**Pure SSH.** Direct file transfer. *Rejected:* requires bastion or VPN
infrastructure, SSH key rotation, drifts as soon as one EC2 has a
different fingerprint. SSM solves all of this without the operational
burden.

**Git as transport (push commits to a fleet-config repo, hosts cron-pull).**
*Rejected as the default*, because it makes fleetmind depend on an
external git repo per fleet and on every host having GitHub auth. It's
a fine *second* transport (`fleetmind deploy --transport=git`) for ops
already running that pattern, but not the default.

**Sudoers entry instead of named SSM document.** Run the deploy chain as
the `openclaw` user; allow `openclaw ALL=(root) NOPASSWD: /bin/systemctl
restart openclaw-gateway` in sudoers. *Rejected:* sudoers config drifts
across hosts more easily than a Terraform-managed SSM document. The
named-document approach also gives us pinned versions and CloudTrail
attribution for free.

**Pure S3 + cron pull on host.** Hosts poll S3 for new tarballs. *Rejected:*
no synchronous "did it apply?" feedback, hard to report failure to the
operator, restart timing is fuzzy.

## Open decisions deferred to follow-on work

These were explicitly raised and explicitly punted:

1. **Drift detection v0.2 — 3-way merge.** v0.1 is fail-loud: hash the
   workspace contents on the host, compare to the expected hash from the
   tarball manifest, refuse to apply if different (unless `--force`).
   v0.2 will explore a 3-way merge for the case where an operator
   intentionally hand-edited a workspace file. Not enough usage data
   yet to design that well.

2. **Skill push reuses transport, narrower scope.** `fleetmind push
   skill <name> --agent <id>` will use the same S3+SSM mechanism with
   a smaller payload (one skill subdir instead of the whole workspace).
   Same SSM document but invoked with `kind=skill` parameter instead of
   `kind=workspace`. No separate transport.

3. **Operator vs CI as caller.** Both should work — SSM SendCommand from
   either context just needs the right IAM. Default doc shows laptop
   flow with an additional CI section.

## Implementation phases

| Phase | Issue | Scope |
|---|---|---|
| 1 | deploy-staging TF module | S3 bucket (versioned, encrypted, lifecycle expiry), reader IAM policy for agent roles, outputs |
| 2 | FleetMindDeployApply SSM document | TF-managed named document with the apply script (download + extract + chown + restart) |
| 3 | openclaw-terraform tagging contract | `fleetmind:agent_id` tag on each agent EC2; reader policy attached to each agent role |
| 4 | fleetmind transport: tar + upload | Render produces tarballs alongside today's outputs; deploy uploads to staging by sha |
| 5 | fleetmind transport: SSM trigger + poll | Deploy issues SendCommand by tag, polls status, reports per-agent results |
| 6 | fleetmind rollback | `fleetmind rollback <sha>` invokes same SSM doc with a prior sha |
| 7 | fleetmind push reuses transport | Refactor push to share the staging+SSM path with deploy |
| 8 (v0.2) | drift detection: 3-way merge | Replace fail-loud-or-force with merge logic |

Phases 1–3 are unblocking for the rest. Phases 4–5 are the minimum
viable v0.1. Phases 6–7 follow naturally; 8 is a separate v0.2 effort.

## Schema additions

`fleet.yaml` gets a new top-level `deploy:` block:

```yaml
deploy:
  transport: ssm                    # ssm | local (current behaviour, dev-only)
  staging:
    bucket: my-fleet-deploy-staging # output of modules/deploy-staging/
  ssm:
    document_name: FleetMindDeployApply
    aws_region: us-west-2
  restart_on_deploy: true           # default; --no-restart flag overrides
```

`transport: local` is preserved for dev — what `fleetmind deploy` does
today (write to local FS, no remote push). `transport: ssm` is the new
default and what production fleets use.

## Out of scope for this design

- *Multi-region fleets.* All agents in one region for v0.1.
- *Cross-account deploys.* The CI/laptop role and the agent EC2s are in
  the same AWS account. Cross-account is a v0.x problem.
- *Blue/green or canary deploys.* `restart_on_deploy: true` restarts
  each agent in series. If you want canary behaviour, do it manually
  by deploying agents one at a time with `--filter`.
- *Secrets push.* `fleetmind secrets export` produces shell exports for
  the operator; pushing secrets to hosts is the operator's job (Secrets
  Manager + EC2 instance role). No change here.

## What this enables

After phases 1–5 land, the docs claim that "`fleetmind deploy` pushes
workspaces to each agent's EC2" becomes true (it isn't today — that
claim was a doc-vs-code drift in PR #5 that the audit caught and that
this design corrects in code rather than docs). Phase 6 enables
`fleetmind rollback`. Phase 7 collapses two parallel transport paths
into one.
