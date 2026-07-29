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

## Historical migrations

The former standalone repository contains migration guidance for releases predating this consolidation. Keep its historical material available while active consumers move to a released FleetMind source.
