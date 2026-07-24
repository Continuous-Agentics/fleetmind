# FleetMind in an existing VPC

Single-agent example for operators who already manage networking outside this module.

The caller supplies `vpc_id` and one or more private subnets. This example disables delegation and NATS to demonstrate the smallest BYO-VPC footprint; enable them when you want the full multi-agent task-ledger flow.

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
| <a name="input_existing_private_subnet_ids"></a> [existing\_private\_subnet\_ids](#input\_existing\_private\_subnet\_ids) | Existing private subnet IDs for FleetMind agents. | `list(string)` | n/a | yes |
| <a name="input_fleet_name"></a> [fleet\_name](#input\_fleet\_name) | Example FleetMind fleet name. | `string` | `"fleetmind-existing-vpc"` | no |
| <a name="input_vpc_id"></a> [vpc\_id](#input\_vpc\_id) | Existing VPC ID. | `string` | n/a | yes |
## Outputs

| Name | Description |
|------|-------------|
| <a name="output_instance_ids"></a> [instance\_ids](#output\_instance\_ids) | EC2 instance IDs for the example agents. |
| <a name="output_ledger_bucket_name"></a> [ledger\_bucket\_name](#output\_ledger\_bucket\_name) | Deploy-staging bucket name for the example fleet. |
<!-- END_TF_DOCS -->
