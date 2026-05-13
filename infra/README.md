# infra/

## Terraform

Terraform for Fleetmind fleets has moved to its own module repo:

- **[`terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind)** — the Terraform module (v0.1.0+)
- **[`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template)** — operator-side starter repo (fork or clone to stand up a fleet)

The legacy `infra/terraform/` direct-apply setup was removed after the gg-sandbox and fleet-test-2 test fleets were torn down on 2026-05-13. New fleets use `fleetmind-template` + `terraform-aws-fleetmind`.

## Scripts

`infra/scripts/` contains standalone shell scripts deployed to agent EC2 instances:

- `gh-app-token.sh` — mints a short-lived GitHub App installation token from AWS SSM credentials. Installed at `/usr/local/bin/gh-app-token` on every agent.
- `store-bot-github-app.sh` — shell-script equivalent of `fleetmind github-app store`. Superseded by the CLI command but kept for reference.
