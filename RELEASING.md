# Releasing fleetmind

fleetmind is published to public npm as `@continuous-agentics/fleetmind`.

## Prerequisites

### npm trusted publishing setup

The publish workflow uses npm trusted publishing via GitHub Actions OIDC. Configure
the `@continuous-agentics/fleetmind` package on npm to trust this repository's
`.github/workflows/publish.yml` workflow before cutting a release.

## Steps

1. **Land all PRs** into `main`.
2. **Update CHANGELOG.md** — move entries under `[Unreleased]` to a new `[X.Y.Z] — YYYY-MM-DD` section. The publish workflow extracts release notes from this section verbatim.
3. **Bump version:**
   ```bash
   npm version minor   # or patch/major as appropriate
   ```
   This updates `package.json` and creates a git tag (e.g. `v0.5.0`).
4. **Push commit + tag — this triggers the rest automatically:**
   ```bash
   git push && git push --tags
   ```
   The push of the `vMAJOR.MINOR.PATCH` tag fires `.github/workflows/publish.yml`, which:
   - Runs `npm ci` + build + tests
   - Publishes to public npm (`@continuous-agentics/fleetmind`)
   - Creates a GitHub Release using the matching `[X.Y.Z]` section from CHANGELOG.md as notes

   Watch the workflow run at `https://github.com/Continuous-Agentics/fleetmind/actions`. If it fails after build/test, the tag is still there but no publish/release happens — fix the issue and re-trigger via the Actions UI (manual `workflow_dispatch` with `confirm=publish`).

5. **Update consumer infra:**
   Bump `fleetmind_version` in `fleetmind-template/workspaces/default.tfvars` (and any per-fleet `<fleet>.tfvars`) to match:
   ```hcl
   fleetmind_version = "0.5.0"
   ```
6. **Apply Terraform** in each consuming fleet:
   ```bash
   terraform apply
   ```
   EC2 instances are replaced; bootstrap installs the new version from public npm.

## Tag-trigger details

The publish workflow's tag filter is strict semver: `v[0-9]+.[0-9]+.[0-9]+`. Typo'd tags (`v0.5.2.` or `v0.5-rc`) do **not** trigger a publish — they push to the repo as ordinary tags but no workflow fires.

For pre-releases (e.g. `v0.6.0-rc.1`), the workflow publishes to the `beta`
dist-tag. Install explicitly with `npm install -g @continuous-agentics/fleetmind@beta`
or `fleetmind self-upgrade --to 0.6.0-rc.1 --apply`.

## Manual workflow_dispatch (debug / rerun)

If you need to re-publish (e.g. a flake in the original tag-push run):

1. Go to `https://github.com/Continuous-Agentics/fleetmind/actions/workflows/publish.yml`
2. Click **Run workflow**
3. Branch: `main` (or the tagged ref)
4. Type `publish` in the `confirm` input
5. Run

The manual path skips the auto-create-GitHub-Release step (the release usually already exists).
