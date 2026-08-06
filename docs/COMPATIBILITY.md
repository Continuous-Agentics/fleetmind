# FleetMind Compatibility

## One release, one contract

FleetMind ships the CLI, runtime bootstrap, and Terraform module from this repository. Keep them on the same release:

| Consumer surface | v1.1.0 value |
|---|---|
| npm/runtime pin | `1.1.0` |
| Terraform module source | `git::https://github.com/Continuous-Agentics/fleetmind.git//infra/terraform/modules/fleetmind?ref=v1.1.0` |
| Embedded Terraform root | `infra/terraform` at tag `v1.1.0` |

The npm package version omits the Git tag’s `v` prefix. Do not combine a runtime package from one FleetMind release with Terraform from another release or an untagged branch.

`fleetmind-template` is an optional operator scaffold. If you use it, update its FleetMind runtime and module-source pins together to the target FleetMind release.

## v1.1.0 baseline

| Component | Baseline |
|---|---|
| FleetMind CLI/runtime | `1.1.0` |
| OpenClaw | `2026.7.1` or newer |
| Node.js | `24` |
| Terraform | `>= 1.5` |
| AWS provider | `~> 5.0` |

## Upgrade checklist

1. Update the Terraform module source and `fleetmind_version` to the same FleetMind release.
2. Run `fleetmind render --check`, then `fleetmind render`.
3. Review `terraform plan` before applying. Stop on unexpected replacement, broad IAM expansion, or deletion.
4. Apply Terraform, then use the release’s documented host-update path for existing hosts. Bootstrap changes do not automatically modify already-running instances.
5. Re-run onboarding only when the release notes specifically call for it.

Use an explicit backend key for new fleets. Terraform CLI workspaces are supported only as a legacy-state migration path; a fresh checkout must select the existing workspace before operating on legacy workspace-backed state.

## GitHub App lifecycle

GitHub access is explicit per agent. Declare every usable App under `github_apps`; use `project: {}` for the legacy project namespace and named Apps with both `owner` and `org`. `github_app` remains a permissions/event-defaults object only.

Run `fleetmind render` once to migrate legacy `github_access` settings. Terraform receives App names solely to scope IAM; PEMs, App IDs, installation IDs, and tokens never enter Terraform variables, plans, or state.

## Historical references

Older changelog and migration entries may link to the archived `terraform-aws-fleetmind` repository. Those links document past releases; they are not a source for new-fleet module pins.
