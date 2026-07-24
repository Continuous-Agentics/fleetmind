# Contributing to FleetMind

Thank you for your interest in contributing. This document covers local setup, test expectations, pull request conventions, and release rules for the FleetMind CLI.

## Dev Setup

**Prerequisites:** Node.js 22+ and npm. FleetMind is written in TypeScript and published as the `@continuous-agentics/fleetmind` npm package.

External contributors should fork first, then clone their fork:

```bash
gh repo fork Continuous-Agentics/fleetmind --clone
cd fleetmind
npm ci
npm run build
npm test
```

Maintainers can clone upstream directly:

```bash
git clone https://github.com/Continuous-Agentics/fleetmind.git
cd fleetmind
npm ci
npm run build
npm test
```

## Test Conventions

- Test runner: Node's built-in test runner (`node --test` via `npm test`).
- TypeScript must compile cleanly with `npm run build`.
- Prefer deterministic unit tests with mocked AWS, GitHub, Slack, filesystem, and subprocess boundaries.
- Do not call real AWS/GitHub/Slack services from unit tests.
- Add regression tests for renderer/schema/onboard behavior when changing `fleet.yaml`, generated tfvars, workspace layout, or bootstrapping assumptions.
- Do not hardcode the total test count in docs; say the full suite passes.

## Compatibility Contract

FleetMind uses this repository plus a template companion:

- `fleetmind` — CLI, renderer, runtime helpers, bundled skills, and `infra/terraform` AWS infrastructure module
- `fleetmind-template` — starter repo and operator docs

If a change affects generated Terraform variables, secret names, bootstrap behavior, push/pull-self, package publishing, or operator docs, update `docs/COMPATIBILITY.md` and coordinate companion PRs in the other repos.

## Branch & Commit Conventions

Use Conventional Commits:

```text
feat | fix | docs | chore | refactor | test
```

Branch off `main`:

```bash
git checkout main && git pull --ff-only
git checkout -b docs/your-change
```

Keep PRs focused. Squash noisy WIP commits before opening a PR.

## Pull Request Conventions

- Title: Conventional Commit style, for example `fix: validate module pin before render`.
- Body: describe what changed, why it matters, and how it was verified.
- Link issues with `Closes #123` or `Refs #123`.
- CI must be green before merge.
- Update docs and `CHANGELOG.md` when behavior, public commands, package metadata, compatibility, or operator workflows change.
- At least one maintainer approval is required to merge to `main`.

## Where to File Things

| What | Where |
|------|-------|
| Bug reports | GitHub Issues with the `bug` label |
| Feature requests | GitHub Issues with the `enhancement` label |
| Documentation fixes | GitHub Issues or PRs with the `documentation` label |
| Security vulnerabilities | GitHub Security Advisories; do not file publicly |
| Cross-repo compatibility issues | Start in this repo and link companion issues/PRs in template/module repos |

## Releases

Releases are maintainer-only.

The release flow is intentionally gated:

1. A `v*` tag creates a draft GitHub Release.
2. The release maintainer publishes the GitHub Release when ready.
3. The `publish.yml` workflow publishes to npm via trusted publishing.
4. The workflow is guarded so only GitHub actor `ggettert` can publish.

Before tagging:

- [ ] `CHANGELOG.md` updated.
- [ ] `package.json` version bumped.
- [ ] CI green on `main`.
- [ ] `docs/COMPATIBILITY.md` reflects the intended CLI/module/template baseline.
- [ ] Public npm metadata checked after publish (`npm view @continuous-agentics/fleetmind version license`).

## License / DCO

No CLA is required. By contributing, you agree that your contributions are licensed under the project's [MIT license](./LICENSE). The standard inbound=outbound licensing model applies.

## Conduct

Be direct, respectful, and constructive. Maintainers may close or edit issues that are spammy, abusive, or unrelated to FleetMind.
