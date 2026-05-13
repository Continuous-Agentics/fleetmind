# fleetmind — Terraform Infrastructure

Terraform modules and example roots for fleetmind-managed fleets. Two
substrates live here:

- **ContextStore** — single DynamoDB table, fleet-wide hive mind. Provisioned
  by `fleetmind deploy` (rendering happens automatically). Source under
  `modules/context-store/`.
- **Task ledger (delegation)** — DynamoDB tasks table + S3 narrative bucket +
  EventBridge wake pipeline + IAM policies. Optional, enabled per fleet.
  Source under `modules/task-ledger/`. See
  [`docs/integration/delegation.md`](../../docs/integration/delegation.md)
  for the consumer guide.

Bot EC2 hosts and networking are not provisioned by fleetmind — those live in
the [`openclaw-terraform`](https://github.com/Continuous-Agentics/openclaw-terraform)
repo, which fleetmind feeds via the rendered `fleet.derived.tfvars`. That repo
brings up *one EC2 instance per agent in the fleet* (each running its own
OpenClaw gateway), plus the IAM roles fleetmind's modules attach policies
to.

## Layout

```
infra/terraform/
├── modules/
│   ├── context-store/    # single DDB table; fleet-wide shared state
│   └── task-ledger/      # DDB tasks + S3 narratives + wake pipeline + IAM
└── README.md
```

## When to use which module

| Need | Module |
|---|---|
| Fleet-wide shared key/value state any agent or service can read/write | `context-store` |
| Durable PM-bot-to-worker-bot delegation tracking | `task-ledger` |
| Both | Apply both — they're independent |

## `modules/task-ledger/`

Provisions the substrate documented in [`docs/protocol.md`](../../docs/protocol.md):

- DynamoDB table (`{name_prefix}tasks`): pay-per-request, Streams enabled
  (`NEW_AND_OLD_IMAGES`), TTL on `expires_at`, deletion protection on (both
  DDB-native and Terraform `prevent_destroy`)
- Two GSIs: `ProjectStatusIndex` (project-scoped pending) and `StatusIndex`
  (cross-project status filter)
- S3 bucket (`{name_prefix}ledger`): narrative storage; versioning enabled,
  default encryption on, public access blocked
- EventBridge Pipe filtering on terminal status MODIFY records → custom event
  bus → SSM Run Command target on the PM bot's EC2 instance
- DLQ + CloudWatch alarms on Pipe failures (optional `alert_email` for SNS
  subscription)
- Three IAM policies (`{prefix}bot-ledger-pm`, `{prefix}bot-ledger-worker`,
  `{prefix}bot-ledger-reader`) attached to the role names you pass in

### Inputs (key variables)

| Variable | Required | Description |
|---|---|---|
| `name_prefix` | yes | Resource name prefix (e.g. `acme-fleet-`). Trailing `-` recommended. |
| `aws_region` | yes | Region for all resources |
| `pm_role_names` | yes | List of IAM role names that should get the PM policy |
| `worker_role_names` | yes | List of IAM role names that should get the worker policy |
| `wake_target_instance_tag_key` | yes | EC2 tag key the SSM Run Command targets |
| `wake_target_instance_tag_value` | yes | EC2 tag value matching the PM bot host |
| `wake_target_session_key` | yes | OpenClaw session key for the wake handler |
| `alert_email` | no | Email for DLQ SNS subscription |
| `tags` | no | Tags applied to all resources |

### Outputs

`table_name`, `s3_bucket_name`, `pm_policy_arn`, `worker_policy_arn`,
`reader_policy_arn`, `event_bus_arn`, `pipe_arn`.

## `modules/context-store/`

Provisions the single DynamoDB table fleetmind uses for the cross-agent
hive mind. Generally you won't apply this directly — `fleetmind deploy`
handles rendering and apply. Module source is here for review and for
non-fleetmind consumers that want IAM access to the table.

## Example consuming root

See [`docs/integration/delegation.md`](../../docs/integration/delegation.md)
for a complete worked example of a Terraform root that consumes
`modules/task-ledger/`. The same pattern applies for `modules/context-store/`
when you need to wire it manually.

## Region note

After fleetmind 0.3.0 the CLI throws if no AWS region is configured (no more
silent `us-east-1` default). Set `delegation.aws_region` and
`context.region` in `fleet.yaml`, or export `AWS_REGION` /
`AWS_DEFAULT_REGION` when running CLI commands.

## VPC Endpoints

Fleetmind provisions VPC endpoints in two tiers when managing its own VPC
(`var.vpc_id == ""`):

### Gateway endpoints (always on, free)

| Endpoint | Service |
|----------|---------|
| S3 | `com.amazonaws.<region>.s3` |
| DynamoDB | `com.amazonaws.<region>.dynamodb` |

Both gateway endpoints are associated with the private route table so agent
processes reach S3 (narratives bucket) and DynamoDB (task-ledger, context-store)
through the AWS backbone instead of via NAT, improving reliability and
eliminating per-GB NAT transfer costs for those services.

### Interface endpoints (opt-in, ~$80/mo)

Gated by `enable_interface_endpoints = true` in your tfvars:

| Endpoint | Service |
|----------|---------|
| SSM | `com.amazonaws.<region>.ssm` |
| SSM Messages | `com.amazonaws.<region>.ssmmessages` |
| EC2 Messages | `com.amazonaws.<region>.ec2messages` |
| Secrets Manager | `com.amazonaws.<region>.secretsmanager` |

When enabled, `private_dns_enabled = true` ensures the standard AWS SDK
hostnames resolve to the endpoint ENIs — no application changes required.
A dedicated security group (`<fleet_name>-vpc-endpoints-sg`) allows port 443
inbound from the VPC CIDR.

Interface endpoints are **not required** when a NAT gateway is present (the
default). Enable them for:
- Fleets in fully-private subnets without NAT
- Production fleets where SSM access should be independent of NAT health
- Debug/diagnostic environments where you want to rule out NAT as a failure mode

## State management


Use S3 + DynamoDB locking for shared state (`backend "s3"`). `task-ledger`
state is critical — losing it means losing the connection between Terraform
and the resources holding live delegation history. Treat the state bucket
the same as you would any production state bucket: versioning on, MFA
delete recommended, restrictive bucket policy.
