# Scoped AWS application access

Agents remain in their existing agent account and EC2 hosts. Application roles live
in application accounts. This feature adds an independent source IAM policy and an
explicit task command; it does not move hosts, change Terraform state, replace EC2,
change NATS, or switch the credentials of FleetMind's host services.

## Declare access

```yaml
targets:
  agent-host:
    provider: aws-ssm
    aws:
      region: us-west-2
      account_id: '111111111111'
      workload_role_arn: arn:aws:iam::111111111111:role/myfleet-worker-role
aws_access:
  orders-staging-read:
    app: orders
    environment: staging
    access: read
    account_id: '222222222222'
    role_arn: arn:aws:iam::222222222222:role/fleetmind-orders-staging-read
    region: us-west-2
    duration_seconds: 900  # 900–3600; role chaining is limited to one hour
  billing-prod-read:
    app: billing
    environment: prod
    access: read
    account_id: '333333333333'
    role_arn: arn:aws:iam::333333333333:role/fleetmind-billing-prod-read
    region: us-east-1
agents:
  # Keep your existing defaults/list fields. This fragment is illustrative.
  list:
    - id: worker
      name: Worker
      target: agent-host
      aws_access:
        source_role_arn: arn:aws:iam::111111111111:role/myfleet-worker-role
        targets: [orders-staging-read, billing-prod-read]
```

Only commercial AWS IAM role ARNs are supported initially. Account mismatch,
wildcards, duplicate agent IDs/grants, and unknown aliases fail validation. AWS access is
opt-in; configurations without it retain their previous rendering and behavior.
This implementation requires an `aws-ssm` host with IMDSv2. The explicit source ARN
must match that host's assigned workload role, including the exact account. It is
not an operator profile. Never put credentials in YAML.

## IAM: two administrators, two permission checks

`fleetmind render` emits `agent_aws_access_roles`, mapping each agent to only the
exact role ARNs it may assume. Forward this variable to the embedded FleetMind
module in consumer roots (the bundled example root already does so). The module
adds `aws_iam_role_policy.application_access` on the existing agent role. Empty
catalogs create no policies. Removing a target removes its source grant on apply.
Existing role policies and the instance profile are not rewritten.

An authorized **application-account administrator** creates each target role with
trust for the exact source agent role ARN. See
[`examples/aws-application-access/target-role.tf`](../examples/aws-application-access/target-role.tf)
for exact-principal trust and a restricted S3 read permission example. Adapt the
bucket/object scope to the app. Target role permissions enforce the purpose:
alias names and labels are descriptive, not enforcement. No optional client
session policy is relied upon. Do not attach broad admin policies or allow role
chaining from these destination roles. Resource policies, SCPs, permissions
boundaries, KMS permissions and explicit denies still apply. Source AssumeRole
permission alone cannot bypass target trust; target trust alone is insufficient
for cross-account access without the source permission.

## Existing-host delivery (operator workflow)

After review and explicit infrastructure authorization:

1. After `v1.3.0-beta.0` is published, pin the operator CLI and on-host FleetMind
   package to `1.3.0-beta.0` and the embedded Terraform module to
   `v1.3.0-beta.0`. Use the existing CLI upgrade delivery path
   (`fleetmind push fleet --upgrade-cli 1.3.0-beta.0`) if the host needs the new
   helper. No separate helper service or EC2 replacement is needed. Do not change
   rollout triggers, AMIs, instance profile, root volumes or user-data to deliver
   this feature.
2. Render configuration and review the Terraform plan. The access delta must be
   only the independent inline IAM policies; reject any EC2 replacement. The
   module does not feed access variables into the agent instance module.
3. Apply source policies and have each app administrator provision target trust
   and permissions through their independently authorized workflow.
4. Preview `fleetmind aws-access sync --fleet fleet.yaml --agent worker --revision 1 --dry-run`.
   Then submit without `--dry-run`, using the same revision and desired state.
   `--revision` is a required positive safe integer, allocated monotonically per
   agent by the operator's desired-state workflow, not by clocks or host arrival.
   Coordinate allocation across operators: every changed desired state (including
   revocation) needs a greater revision; retries must reuse the original revision
   and payload. Never assign a fresh revision to an old queued/retried grant.
   This command resolves operator credentials
   once, verifies their account against the independent target `aws.account_id`,
   discovers all SSM match pages and requires exactly one EC2 host. It verifies
   EC2 account/tags and the IAM instance profile's exact `aws.workload_role_arn`
   before submitting root publication. These two target fields are mandatory for
   sync, **including removal**; keep them when deleting the `aws_access` block.
   Use a separate named target per distinct workload role. Legacy configurations
   remain valid for other commands but cannot use sync without this binding.
   The operator needs STS identity, SSM discovery/submission, EC2 DescribeInstances,
   and IAM GetInstanceProfile permissions; this change grants none automatically.
   Root publication checks trusted `/etc/fleetmind/agent.env` fleet/agent metadata
   and independently verifies the IMDS workload identity before modifying
   `/etc/fleetmind/aws-access.json`. Catalog contents cannot authorize themselves.
   Only that
   agent's allowed targets are sent; the full catalog and peer grants are not
   put in its workspace slice. There is no runtime path/env override for this
   file. It is root-owned, readable, and not agent-writable; all ancestors are
   checked. The file atomically contains both revision and catalog; removal writes
   a durable null-catalog tombstone rather than deleting the revision watermark.
   Under the publication lock, older revisions and same-revision conflicting
   payloads are rejected. Corrupt/untrusted state fails closed instead of being
   overwritten. Never delete or restore an old copy of this file during rollback:
   doing so discards the revocation watermark. The task reader denies tombstones
   and old unrevisioned catalogs; upgrade both publisher and task runner together.
   An identical retry leaves its inode unchanged but still fsyncs the directory
   before acknowledging success, including after a prior failed durability barrier.
   A bounded root-owned directory
   lock serializes publication, with complete same-directory atomic replacement.
   A crashed publication can leave `.aws-access.lock`; sync then fails closed until
   an operator verifies no publisher is active and removes the stale lock.
   Removing the agent's
   `aws_access` block and syncing with a greater revision revokes the catalog.
5. Sync reports an SSM **submission ID**, not success. Inspect command completion
   using your normal SSM operator workflow. The host checks exact CLI version
   against the operator **and** the `fleetmind-aws-access-sync-v3` capability before
   publication; version `1.2.1` alone is insufficient. Use the published
   `1.3.0-beta.0` runtime with the exact `v1.3.0-beta.0` module tag for this beta.
   Module tag matching is an operator invariant (the runtime cannot inspect the
   consumer's Terraform source tag).
   Neither sync nor task execution restarts OpenClaw or modifies sessions,
   memory, workspaces, service environment or OpenClaw config.

The catalog is managed separately from workspace bundle rollback: an old or
agent-edited workspace cannot restore a revoked grant. Source IAM apply and
catalog sync are distinct operations, not a distributed transaction. For urgent
revocation remove target trust/permissions or revoke active sessions as well;
already issued STS sessions may otherwise survive until expiry.

## Execute a task

```sh
fleetmind aws-access exec orders-staging-read -- aws sts get-caller-identity
fleetmind aws-access exec billing-prod-read -- aws s3 ls s3://billing-reports
```

The command starts an isolated runner environment before loading AWS SDK config.
The SDK's standard IMDS provider obtains the host role credentials (IMDSv2 only),
then STS verifies the source identity, assumes the exact allowed target, and
verifies target account, role and generated session identity. Unknown targets,
credential errors, expired credentials, wrong identities and grants changed
during authorization fail closed **before the task starts**. SDK IMDS stale
credential extensions are rejected using original expiration. There is no
default credential chain and no host/operator fallback. STS request timeouts throw
rather than warn; a total 30-second authorization deadline covers source lookup,
STS requests, retries and response consumption, destroys clients, and prevents
child start on timeout. Operator sync has a separate 60-second total deadline.

The child receives temporary credentials only in its own environment. No
credential files, `credential_process` output, profile switching or tokens in
FleetMind logs are used. Parent environment stays unchanged; two commands for
different accounts can run simultaneously. Profiles, endpoint overrides,
web-identity settings, container credentials, shared credential files and IMDS
fallback are disabled for the child; host service secrets and `NODE_OPTIONS` are
not inherited. PATH is fixed to `/usr/local/bin:/usr/bin:/bin`; use an absolute
binary path for other tools. HOME points at a nonexistent directory to prevent
accidental operator profile reuse. Current working directory is preserved.

External CLI environments cannot refresh safely in place. Each task receives
one session; the process group is killed at expiration minus 30 seconds (exit
124), and remaining subprocesses are killed when the command leader exits.
Long work must be split into new tasks; every invocation rechecks the catalog
and source identity. There is no reusable public SDK refresh provider in this
initial CLI implementation. Signals are forwarded to the task group. Do not
intentionally daemonize/detach tasks: process groups are lifecycle hygiene, not
an OS sandbox.

Audit JSON on stderr records agent, generated run/session, alias, account,
role, verified assumed identity, expiration and completion status. Failures
have a fixed message; SDK errors and command arguments are not logged. STS
session names carry the run ID for CloudTrail correlation. Route stderr to your
normal secured operational log collector if durable auditing is required.
Authorized child programs can themselves print their environment or credentials;
FleetMind cannot redact arbitrary program output.

## Security boundary and network limitations

One agent per host/OS-user is the supported boundary. Alias selection is **not a
security sandbox** against malicious same-user processes. Such a process can read
another process's environment, contact IMDS itself, invoke other tools, or change
its own environment. IAM source grants and target permissions are the actual AWS
boundary; use separate roles/hosts/accounts for mutually untrusted agents. The
helper protects against accidental ambient credential/profile use, not a hostile
program with access to the host workload role. Do not grant the runtime user sudo
write access to `/etc/fleetmind` or the installed FleetMind package if you rely on
the managed-catalog guardrail.

Assuming a role does not create network reachability. Private app endpoints need
a separately authorized connectivity design. This feature does not change VPCs,
backends, account vending, fleet ledgers or transport.

## Offline and live acceptance

Unit tests use injected STS responses and real isolated child processes; no live
AWS, IAM simulator or provider download is required. Static tests assert exact
source-policy resources, exact target trust, scoped target permissions and no
instance wiring change. Static tests are not a Terraform plan or live permission
proof. Before production, authorized operators must verify source and target
AccessDenied cases, allowed app resources and denied unrelated resources, two
parallel real tasks, expiry and alias removal, and a no-replacement Terraform
plan. Live checks have not been run as part of this implementation.
