# 📦 Where are the docs?

FleetMind ships its CLI, runtime helpers, skills, and Terraform implementation from this repository.

| Looking for... | Path |
|---|---|
| **Start here** — install, fleet.yaml, local and AWS workflows | [`README.md`](../README.md) |
| **Terraform root and module** — inputs, outputs, BYO VPC, migrations, standalone task ledger | [`infra/terraform/`](../infra/terraform/) and [`docs/terraform/`](terraform/) |
| **GitHub App lifecycle** | [`docs/GITHUB-APPS.md`](GITHUB-APPS.md) |
| **Delegation** | [`docs/integration/delegation.md`](integration/delegation.md) and [`docs/protocol.md`](protocol.md) |
| **Version contract** | [`docs/COMPATIBILITY.md`](COMPATIBILITY.md) |
| **Release process** | [`RELEASING.md`](../RELEASING.md) |

[`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template) is an optional scaffold for operator repositories. Keep any template’s runtime pin and Terraform module source on the same FleetMind release as this repository; do not use an untagged template branch as a compatibility baseline.
