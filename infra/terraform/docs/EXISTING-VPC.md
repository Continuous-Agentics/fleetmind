# Deploying into an existing VPC (BYO VPC)

This module supports two networking modes:

1. **Create a new VPC** (default) — the module creates a `/16` VPC, two AZs, public + private subnets, NAT gateway, IGW, route tables, and (optionally) interface endpoints.
2. **Bring your own VPC** — you point the module at an existing VPC and supply the public + private subnet IDs. The module skips all VPC/subnet/NAT/IGW/route-table creation.

BYO VPC is the right choice when you have a security-reviewed VPC, no spare `/16` space, or organizational policy requires fleets to land in pre-existing networking. The trade-off is that you take ownership of routing, NAT, and (today) interface endpoints.

---

## How to enable BYO VPC

Set the following variables in your `workspaces/<fleet>.tfvars`:

```hcl
vpc_id                       = "vpc-0abc123def456"
existing_private_subnet_ids  = ["subnet-0ccc...", "subnet-0ddd..."]   # 1+ required, 2+ AZs recommended
existing_public_subnet_ids   = []                                       # optional; unused today

# var.vpc_cidr is ignored when vpc_id is set; you can leave the default.
```

When `var.vpc_id` is non-empty, the module:
- Skips `module.vpc` (no `terraform-aws-modules/vpc/aws` invocation)
- Reads the existing VPC's CIDR block via `data "aws_vpc" "existing"` (used for security-group rules)
- Wires per-agent EC2 instances into your supplied private subnets (round-robin across the list)
- Wires the fleet security group into your supplied VPC

---

## Requirements your existing VPC must meet

The module enforces the bare minimum in the variable schema and assumes the rest:

- **At least 1 private subnet** (validated). 2+ in distinct AZs is recommended — agents are round-robin-placed via `% length(subnets)`, and the NATS server uses the first subnet. Single-subnet deployments work but lose AZ-isolation properties.
- **Public subnets are optional** (no validation; the variable exists for parity with the created-VPC path and to leave room for future public-facing resources like an ALB). Today nothing in the module reads `local.public_subnet_ids` for BYO VPC, so an empty list is fine.
- **Outbound internet from private subnets.** Bot bootstrap pulls FleetMind from public npm, calls the configured model provider's API, AWS APIs, and SSM. Without NAT or VPC endpoints, bootstrap fails.
- **DNS resolution + DNS hostnames enabled on the VPC.** Required for SSM and Secrets Manager.
- **S3 gateway endpoint** (or NAT) in the route tables associated with private subnets. The module's bootstrap downloads tarballs from the fleet's ledger S3 bucket; without an S3 endpoint, you pay NAT for every push.

---

## Interface endpoints in BYO VPC mode

⚠️ **Known limitation:** When `var.vpc_id` is set, `var.enable_interface_endpoints` has no effect. The module's interface-endpoint creation (`vpc.tf:73`) is gated on `local.create_vpc`, so BYO VPC fleets get zero interface endpoints from this module even when `enable_interface_endpoints = true`.

If you want SSM/SecretsManager/EC2 Messages traffic to avoid NAT in a BYO VPC, you need to create those endpoints yourself, attaching them to your existing private subnets. Required endpoint services:

- `com.amazonaws.<region>.ssm`
- `com.amazonaws.<region>.ssmmessages`
- `com.amazonaws.<region>.ec2messages`
- `com.amazonaws.<region>.secretsmanager`

Each should be type `Interface`, attached to your private subnets, and use a security group that allows ingress from the fleet security group's CIDR on TCP 443.

A future module version will decouple `enable_interface_endpoints` from `local.create_vpc` so BYO VPC callers can opt into module-managed endpoints. Tracked in fleetmind#136.

---

## Switching between modes

Switching from create-VPC to BYO-VPC (or vice versa) is **destructive** — Terraform will plan to destroy the previously-created VPC + subnets + NAT + IGW. EC2 instances + IAM roles + secrets are preserved (they reference the VPC via attribute, not direct dependency, in most cases — but EC2 instances are pinned to specific subnets via `subnet_id`, so they'll be replaced).

Recommended pattern: don't switch on a live fleet. Stand up the new fleet in the target VPC, migrate state (Slack apps + DDB content), tear down the old.

---

## Verification after apply

```bash
# Confirm the module attached to your VPC
terraform output vpc_id           # should equal your var.vpc_id

# Confirm subnets resolve
aws ec2 describe-subnets --subnet-ids <subnet-ids> \
  --query 'Subnets[].[SubnetId,VpcId,AvailabilityZone,MapPublicIpOnLaunch]' \
  --output table

# Confirm SSM connectivity from a bot instance
aws ssm start-session --target <instance-id> --region <region>
```

If `aws ssm start-session` hangs or returns `TargetNotConnected`, the bot can't reach SSM endpoints — either NAT is missing or the interface endpoints aren't in place.

---

## Related

- Module-level troubleshooting: [`MODULE-TROUBLESHOOTING.md`](./MODULE-TROUBLESHOOTING.md)
- Migrations between module versions: [`MIGRATIONS.md`](./MIGRATIONS.md)
