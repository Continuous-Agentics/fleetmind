# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Entries reconstructed from git history. Each version's commits are listed
     under the tag that sealed them. "Breaking" items are marked with ⚠️.       -->

## [Unreleased]

### Fixed
- Always grant agent roles read/list access to the fleet bucket's `deploy-staging/` prefix. `fleetmind push fleet` uses this prefix for every fleet, including fleets with `delegation_enabled = false`.

### Changed
- Install FleetMind from public npm during agent bootstrap; remove the shared GitHub Packages PAT SSM read policy from agent roles.
- Refresh README/docs for the v1 module baseline and link to the FleetMind compatibility matrix.

## [1.1.0] - 2026-07-09

### Added
- `dynamodb:PutItem` permission for worker IAM policy (task-ledger) — enables CON-91 self-start rows (#10)

## [1.0.3] - 2026-06-20

### Fixed
- Manage the gateway secret in Secrets Manager and guard bootstrap STAGE 7b against missing secret (#30)

## [1.0.2] - 2026-06-20

### Changed
- License: switched from open source to Continuous Agentics Proprietary License

## [1.0.1] - 2026-06-19

### Changed
- Docs: removed remaining references to the deleted EventBridge/SSM wake pipeline (#28)

## [1.0.0] - 2026-06-04

### Changed
- CI: replaced release-please with one-shot tag-and-release on merge (#25, #23)

*This tag marks the stable public API. No functional Terraform changes from v0.5.0.*

## [0.5.0] - 2026-06-04

### Added
- Per-provider Secrets Manager secrets with canonical naming (`/model/<provider>`) (#22)

## [0.4.3] - 2026-05-28

### Fixed
- Bootstrap STAGE 7c: generate real hooks token (was missing entirely) (#21)

## [0.4.2] - 2026-05-28

### Fixed
- Bootstrap: escape `NATS_HEALTH_URL` and loop variable `$i` inside `ExecStartPre` heredoc (#20)

## [0.4.1] - 2026-05-27

### Fixed
- VPC: relax BYO-VPC subnet validation to accept module consumers' subnet shapes (#19)

## [0.4.0] - 2026-05-27

### Changed ⚠️
- Renamed per-agent Secrets Manager secret from `/anthropic` to `/model` (provider-neutral) (#18) — **breaking** if consuming agents hard-code the old path

## [0.3.0] - 2026-05-27

### Added
- Terraform CI workflow (plan/validate on PRs)
- NATS: rollout triggers and optional TLS support

## [0.2.4] - 2026-05-27

### Removed
- Deprecated `log_time` setting from NATS server configuration (#17)

## [0.2.3] - 2026-05-27

### Added
- NATS monitoring HTTP endpoint (`/healthz`) for health checks (#16)

### Fixed
- Bootstrap: use `tar.gz` archive format when installing NATS binary (#16)

## [0.2.2] - 2026-05-26

### Changed
- `nats_enabled` now defaults to `true` — NATS is the standard delegation transport

## [0.2.1] - 2026-05-26

### Fixed
- Bootstrap: start the NATS subscriber `systemd` path unit on first boot (#15)

## [0.2.0] - 2026-05-26

### Added
- NATS server EC2 instance with AWS Cloud Map service discovery (#13) — replaces the EventBridge Pipe / SSM Run Command wake pipeline as the PM notification transport

## [0.1.7] - 2026-05-19

### Added
- `var.architecture` — choose `arm64` (Graviton, new default) or `x86_64`; AMI selection follows (#11) ⚠️ **breaking**: prior default was x86_64
- Write `WORKSPACE_BASE` to `/etc/fleetmind/agent.env` on bootstrap (#12)

### Removed ⚠️
- `var.agent_port` / `var.agent_ports` — gateway port is now sourced from `fleet.yaml` at runtime (#11)

### Fixed
- BYO-VPC: subnet count and task-ledger S3 data lookup chicken-and-egg (#11)

### Changed
- Docs: added module-level operator documentation (#9)

## [0.1.6] - 2026-05-13

### Fixed
- Bootstrap: log `gh` CLI install failures to console instead of silently swallowing them (#8)

## [0.1.5] - 2026-05-13

### Fixed
- Bootstrap: move `gh` CLI install after critical stages; make it non-fatal so a `gh` failure doesn't abort agent startup (#7)

## [0.1.4] - 2026-05-13

### Fixed
- Move ledger S3 bucket to root module — always created regardless of `delegation_enabled`, preventing a plan-time error (#5)

## [0.1.3] - 2026-05-13

### Fixed
- Security group: replace em-dash character in description with an ASCII hyphen (#3)

## [0.1.2] - 2026-05-13

### Fixed
- Use a static `count` boolean (not a dynamic expression) and gzip `user_data` to stay within the 16 KB EC2 limit (#2)

## [0.1.1] - 2026-05-13

### Fixed
- Bootstrap: preserve `.npmrc` registry config so `fleetmind` self-upgrade works (#1)

## [0.1.0] - 2026-05-13

### Added
- Initial release, ported from `fleetmind/infra/terraform/` @ b64042d
- Root module: VPC (via `terraform-aws-modules/vpc`), security groups, agent EC2s via `modules/agent` submodule
- `modules/agent`: per-agent EC2, IAM role, Secrets Manager secret, bootstrap script
- `modules/networking`: extracted networking submodule (later superseded by community VPC module)
- `modules/task-ledger`: DynamoDB tasks table, S3 narratives bucket, PM/worker/reader IAM policies
- `var.context_store_backend` (DynamoDB-only; drops earlier RDS support)
- `var.delegation_enabled`: gate all delegation substrate behind a flag (default `false`)

### Removed
- RDS backend — dropped in favour of DynamoDB-only context store


[1.1.0]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Continuous-Agentics/terraform-aws-fleetmind/releases/tag/v0.1.0
