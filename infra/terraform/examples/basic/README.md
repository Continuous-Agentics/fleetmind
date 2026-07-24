# Basic FleetMind fleet

Minimal two-agent FleetMind deployment that creates its own VPC, private subnets, ContextStore table, deploy-staging bucket, NATS server, and task-ledger substrate.

Use this as a starting point for a real fleet root module. Before applying, configure an explicit remote backend key for the fleet and provide the required runtime secrets documented in the root module README.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.5 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | ~> 5.0 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_fleetmind"></a> [fleetmind](#module\_fleetmind) | ../.. | n/a |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_aws_region"></a> [aws\_region](#input\_aws\_region) | AWS region to deploy into. | `string` | `"us-west-2"` | no |
| <a name="input_fleet_name"></a> [fleet\_name](#input\_fleet\_name) | Example FleetMind fleet name. | `string` | `"fleetmind-example"` | no |
## Outputs

| Name | Description |
|------|-------------|
| <a name="output_instance_ids"></a> [instance\_ids](#output\_instance\_ids) | EC2 instance IDs for the example agents. |
| <a name="output_ledger_bucket_name"></a> [ledger\_bucket\_name](#output\_ledger\_bucket\_name) | Deploy-staging bucket name for the example fleet. |
| <a name="output_vpc_id"></a> [vpc\_id](#output\_vpc\_id) | VPC ID created for the example fleet. |
<!-- END_TF_DOCS -->
