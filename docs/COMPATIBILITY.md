# FleetMind Compatibility

FleetMind is a three-repo system:

- `fleetmind` — CLI, renderer, runtime helpers, bundled OpenClaw templates and skills
- `fleetmind-template` — operator repo scaffold, Terraform root, fleet docs
- `terraform-aws-fleetmind` — AWS infrastructure module

Use compatible versions across all three. Version drift usually shows up as missing secrets, bootstrap failures, or Terraform variables that no longer match the rendered schema.

## Current v1.0 Baseline

| Component | Version / baseline |
|---|---|
| FleetMind CLI | `1.0.2` |
| `terraform-aws-fleetmind` | `main` at or after [`e80207e`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind/commit/e80207e1e5de43f2e6175663f13ca2c4bc598322) (#47) |
| `fleetmind-template` | `main` at or after the v1 docs audit |
| OpenClaw runtime | `2026.7.1` or newer |
| Node.js | `22` recommended |
| Terraform | `>= 1.5` |

## Matrix

| FleetMind CLI | `terraform-aws-fleetmind` | `fleetmind-template` baseline | Compatibility notes |
|---|---|---|---|
| `1.0.2` | `main` at or after [`e80207e`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind/commit/e80207e1e5de43f2e6175663f13ca2c4bc598322) (#47) | `main` at or after the v1 docs audit | Runs AWS OpenClaw operations through the `openclaw` runtime-user's user-systemd session; onboarding hands SSM operators the module's `ocalias`/`oc*` shortcuts; drops the `terraform workspace` dependency from `fleetmind onboard` |
| `1.0.0` | `v1.1.5` | `main` at or after the v1 docs audit | v1.0 public release baseline: public npm path, MIT license metadata, guided Terraform onboarding, no-delegation deploy-staging IAM fix |
| `0.10.4` | `v1.1.5` | `main` at or after the v1 docs audit | Public npm smoke-test baseline; npm metadata was published before MIT license metadata landed |
| `0.10.1` | `v1.1.0` | `main` at or after the v1 docs audit | Initial public npm path, guided Terraform onboarding, usable `agent connect` gateway token output |
| `0.10.0` | `v1.1.0` | `main` at or after `9775866` | Guided Terraform onboarding, NATS delegation acceptance baseline |
| `0.9.x` | `v1.1.0` | `main` at or after PR #25 | OpenClaw 2026.7.1 compatibility and v1.1.0 module behavior |
| `0.8.x` | `v0.5.x`–`v1.0.x` | `main` at or after PR #18 | Per-provider Secrets Manager paths; every agent must declare `providers:` |
| `0.7.x` | `v0.4.x` | historical only | Known secret-schema drift with newer renderers; do not use for new fleets |
| `0.6.x` and earlier | `v0.1.x`–`v0.3.x` | historical only | Pre-v2 `fleet.yaml` and older delegation wiring |

## Upgrade Rules

- Upgrade the template/module pins before applying a newer FleetMind CLI to a fleet.
- The concise AWS runtime-account handoff (`sudo -iu openclaw`, then `ocalias`
  and the `oc*` shortcuts) requires a `terraform-aws-fleetmind` pin at or after
  [#47](https://github.com/Continuous-Agentics/terraform-aws-fleetmind/pull/47).
  Keep the module pin on the existing baseline until that prerequisite is
  available; the aliases are not guaranteed before it.
- Run `fleetmind render --check` before `terraform plan`.
- Read the FleetMind `CHANGELOG.md` entry for the target version; schema-affecting releases call out required module/template changes.
- Use exact `fleetmind_version` pins in `workspaces/<workspace>.tfvars`; do not use `latest` for EC2 bootstrap.
- Re-run `fleetmind onboard` after upgrades that touch Terraform, provider secrets, gateway tokens, GitHub App setup, or OpenClaw runtime configuration.

## Known Sharp Edges

- `0.7.x` and older renderers used earlier secret naming conventions. New fleets should start on the v1.0 baseline instead of upgrading through those versions.
- `delegation_enabled = false` disables the Terraform task-ledger substrate; do not test PM-to-worker delegation in that mode.
- `fleetmind-template` is not version-tagged. Use the changelog and commit baseline instead of expecting semver tags.
- **CLI versions after fleetmind#255 no longer run `terraform workspace select`/`new` during `fleetmind onboard`.** If an existing fleet's state lives in a non-default CLI workspace (`env:/<fleet>/...` in the shared state bucket), Terraform remembers the last-selected workspace locally in `.terraform/environment`, so nothing breaks as long as that workspace is already selected in your working copy. On a fresh clone/checkout (or CI runner) where no workspace has been selected yet, run `terraform workspace select <fleet-name>` once in the Terraform directory *before* re-running `fleetmind onboard`, or migrate to an explicit backend `key` first (see [`terraform-aws-fleetmind` docs/MODULE-TROUBLESHOOTING.md § Migrating from CLI workspaces to explicit backend keys](https://github.com/Continuous-Agentics/terraform-aws-fleetmind/blob/main/docs/MODULE-TROUBLESHOOTING.md#migrating-from-cli-workspaces-to-explicit-backend-keys)). Always inspect `terraform plan` output before applying — a plan that proposes recreating existing resources from scratch means the wrong workspace is selected.

## Future Runtime Check

The next hardening step is a render-time compatibility check that reads the consumer repo's `main.tf`, extracts the `terraform-aws-fleetmind?ref=...` pin, and warns or errors when it is outside the known-good range for the installed FleetMind CLI.
