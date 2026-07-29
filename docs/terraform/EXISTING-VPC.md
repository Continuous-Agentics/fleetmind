# Deploying into an existing VPC (BYO VPC)

Two networking modes:

1. **Create a new VPC** (default) — `/16` VPC, two AZs, public + private subnets, NAT gateway, IGW, route tables, optional interface endpoints.
2. **Bring your own VPC** — point the module at an existing VPC + subnet IDs; the module skips all VPC/subnet/NAT/IGW/route-table creation.

BYO VPC trade-off: you own routing, NAT, and interface endpoints.

## Enabling BYO VPC

Set in `workspaces/<fleet>.tfvars`:

```hcl
vpc_id                       = "vpc-0abc123def456"
existing_private_subnet_ids  = ["subnet-0ccc...", "subnet-0ddd..."]   # 1+ required, 2+ AZs recommended
existing_public_subnet_ids   = []                                     # optional; unused today

# var.vpc_cidr is ignored when vpc_id is set; leave the default.
```

With `var.vpc_id` set, the module skips `module.vpc`, reads the VPC's CIDR via `data "aws_vpc" "existing"` (for SG rules), and round-robins agent EC2s across your supplied private subnets.

## Requirements your VPC must meet

- **At least 1 private subnet** (validated); 2+ in distinct AZs recommended — agents round-robin via `% length(subnets)`, NATS uses the first.
- **Public subnets optional** — unused in BYO VPC mode today.
- **Outbound internet from private subnets** — bootstrap needs npm, model provider API, AWS APIs, SSM.
- **DNS resolution + DNS hostnames enabled** (required for SSM and Secrets Manager).
- **S3 gateway endpoint** (or NAT) on private-subnet route tables — without it you pay NAT for every push.

## Interface endpoints in BYO VPC mode

⚠️ `var.enable_interface_endpoints` has no effect when `var.vpc_id` is set — interface-endpoint creation (`vpc.tf:73`) is gated on `local.create_vpc`. BYO VPC fleets get zero interface endpoints from this module regardless of the flag.

Create these yourself against your private subnets (type `Interface`, SG allowing ingress from the fleet SG on TCP 443) to keep SSM/SecretsManager/EC2Messages traffic off NAT:

- `com.amazonaws.<region>.ssm`
- `com.amazonaws.<region>.ssmmessages`
- `com.amazonaws.<region>.ec2messages`
- `com.amazonaws.<region>.secretsmanager`

Tracked in fleetmind#136.

## Switching between modes

**Destructive.** Terraform destroys the previous VPC/subnets/NAT/IGW; EC2 instances get replaced (pinned via `subnet_id`); IAM roles/secrets are preserved.

Don't switch a live fleet — stand up the new fleet in the target VPC, migrate state, then tear down the old one.

## Verification after apply

```bash
terraform output vpc_id   # should equal your var.vpc_id

aws ec2 describe-subnets --subnet-ids <subnet-ids> \
  --query 'Subnets[].[SubnetId,VpcId,AvailabilityZone,MapPublicIpOnLaunch]' --output table

aws ssm start-session --target <instance-id> --region <region>
```

If `aws ssm start-session` hangs or returns `TargetNotConnected`, the bot can't reach SSM — NAT is missing or interface endpoints aren't in place.

## Related

- [`MODULE-TROUBLESHOOTING.md`](./MODULE-TROUBLESHOOTING.md) — module-level troubleshooting.
- [`MIGRATIONS.md`](./MIGRATIONS.md) — migrations between module versions.
