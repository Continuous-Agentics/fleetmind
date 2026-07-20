# Contributing to FleetMind

Thanks for improving FleetMind. Keep changes small, tested, and tied to a GitHub issue when possible.

## Local Setup

```bash
npm ci
npm run build
npm test
```

## Pull Requests

- Open PRs against `main`.
- Include the problem, the fix, and verification in the PR body.
- Update docs and `CHANGELOG.md` when behavior, public commands, package metadata, or operator workflows change.
- Keep FleetMind CLI, `fleetmind-template`, and `terraform-aws-fleetmind` compatibility in sync. Update `docs/COMPATIBILITY.md` when a change requires a new module or template baseline.

## Releases

Publishing is intentionally gated. Only `ggettert` publishes npm releases through the GitHub Release flow.

