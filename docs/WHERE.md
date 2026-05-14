# 📦 Where are the docs?

This npm tarball intentionally ships only the docs relevant to using the **fleetmind CLI itself** — the delegation protocol spec and the integration notes for the agent runtime.

Most operator-facing documentation (bring-up, day-2 ops, troubleshooting, vocabulary, GitHub Apps, multi-fleet, BYO VPC, etc.) lives in two companion repos:

| Looking for... | Repo + path |
|---|---|
| **Bring-up & ops** (QUICKSTART, SETUP-A-FLEET, MULTI-FLEET, OPERATING, TROUBLESHOOTING, GITHUB-APPS, CONCEPTS) | [`Continuous-Agentics/fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template) → `docs/` |
| **Module details** (inputs, outputs, BYO VPC, IaC troubleshooting, migrations, standalone task-ledger) | [`Continuous-Agentics/terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind) → `docs/` |

If you're operating a fleet from a `fleetmind-template`-derived repo, all the docs you need are in your own repo under `docs/`.
