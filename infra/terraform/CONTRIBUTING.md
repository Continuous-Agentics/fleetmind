# Contributing to FleetMind Terraform

Thank you for your interest in contributing. This repo contains the AWS Terraform module used by FleetMind fleets, so changes should be deliberate, reviewable, and explicit about operator impact.

## Dev Setup

**Prerequisites:** Terraform `>= 1.5` and AWS provider compatibility with the checked-in lockfile.

External contributors should fork first, then clone their fork:

```bash
gh repo fork Continuous-Agentics/fleetmind --clone
cd fleetmind/infra/terraform
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

Maintainers can clone upstream directly:

```bash
git clone https://github.com/Continuous-Agentics/fleetmind.git
cd fleetmind/infra/terraform
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

Do not run `terraform apply` against a real AWS account unless the PR explicitly needs a live infrastructure smoke test.

## Test Conventions

- Run `terraform fmt -check -recursive` for every change.
- Run `terraform init -backend=false` and `terraform validate` before opening a PR.
- For IAM, bootstrap, SSM, Secrets Manager, S3, DynamoDB, or Cloud Map changes, include either a live smoke-test note or a clear reason validation-only evidence is enough.
- Keep examples, docs, variables, outputs, and changelog aligned.
- Redact AWS account IDs, secret names containing customer identifiers, Terraform state, Slack tokens, GitHub App credentials, and provider API keys before sharing logs.

## Compatibility Contract

This module is consumed by `fleetmind-template` and driven by generated tfvars from `@continuous-agentics/fleetmind`.

When changing inputs, outputs, IAM policy shape, bootstrap behavior, secret names, S3/DDB layout, or deployment semantics:

- update `CHANGELOG.md`
- update README/docs
- coordinate companion PRs in `fleetmind` and `fleetmind-template` when needed
- update the compatibility matrix in `Continuous-Agentics/fleetmind/docs/COMPATIBILITY.md` when the recommended module baseline changes

## Branch & Commit Conventions

Use Conventional Commits:

```text
feat | fix | docs | chore | refactor | test
```

Branch off `main`:

```bash
git checkout main && git pull --ff-only
git checkout -b fix/your-change
```

Keep PRs focused. Squash noisy WIP commits before opening a PR.

## Pull Request Conventions

- Title: Conventional Commit style, for example `fix: grant deploy-staging read to all agents`.
- Body: describe what changed, why it matters to operators, and how it was verified.
- Link issues with `Closes #123` or `Refs #123`.
- CI must be green before merge.
- Include migration notes for changes that affect existing deployed fleets.
- At least one maintainer approval is required to merge to `main`.

## Where to File Things

| What | Where |
|------|-------|
| Module bugs | GitHub Issues with the `bug` label |
| Infrastructure feature requests | GitHub Issues with the `enhancement` label |
| Documentation gaps | GitHub Issues or PRs with the `documentation` label |
| Security vulnerabilities | GitHub Security Advisories; do not file publicly |
| CLI or template bugs | File in `fleetmind` or `fleetmind-template` and link back if module behavior is affected |

## Releases

Releases are maintainer-only. Module releases are tagged and consumed by `fleetmind-template` via the `?ref=vX.Y.Z` module source pin.

Before tagging or merging release-affecting changes:

- [ ] `CHANGELOG.md` updated.
- [ ] Terraform checks pass.
- [ ] README/docs reflect new inputs, outputs, IAM, bootstrap, or migration behavior.
- [ ] Template/module compatibility is updated if this becomes the recommended baseline.

## License / DCO

No CLA is required. By contributing, you agree that your contributions are licensed under the project's [MIT license](./LICENSE). The standard inbound=outbound licensing model applies.

## Conduct

Be direct, respectful, and constructive. Maintainers may close or edit issues that are spammy, abusive, or unrelated to FleetMind.
