# Terraform module provenance

`infra/terraform/` is FleetMind's canonical AWS fleet Terraform module.

It was mechanically ported from `Continuous-Agentics/terraform-aws-fleetmind` at commit `d07db939dd1ebc05048b219f6478c2d698cf6143`, after its latest released version, `v1.1.9`. No resources, inputs, outputs, or module behavior were redesigned as part of the port.

The standalone repository and its historical tags remain available for existing consumers. New consumers should use the FleetMind path after the first FleetMind release tag containing this directory is published:

```hcl
module "fleetmind" {
  source = "git::https://github.com/Continuous-Agentics/fleetmind.git//infra/terraform?ref=<fleetmind-release-tag>"
}
```

Do not point production consumers at `main`. The `fleetmind-template` source pin will move in a follow-up PR after that release tag exists.
