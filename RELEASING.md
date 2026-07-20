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
4. **Push commit + tag — this creates a draft GitHub Release:**
   ```bash
   git push && git push --tags
   ```
   The push of the `vMAJOR.MINOR.PATCH` tag fires `.github/workflows/release.yml`,
   which creates a draft GitHub Release when the actor is `ggettert`.

5. **Grace publishes the GitHub Release manually.**
   Publishing the release as the real `ggettert` identity is the intentional gate
   that fires `.github/workflows/publish.yml`, which:
   - Runs `npm ci` + build + tests
   - Publishes to public npm (`@continuous-agentics/fleetmind`)

   Watch the workflow run at `https://github.com/Continuous-Agentics/fleetmind/actions`.
   If it fails after build/test, the tag and GitHub Release are still there but npm
   publish did not complete — fix the issue and re-trigger via the Actions UI
   (manual `workflow_dispatch` with the existing tag).

6. **Update consumer infra:**
   Bump `fleetmind_version` in `fleetmind-template/workspaces/default.tfvars` (and any per-fleet `<fleet>.tfvars`) to match:
   ```hcl
   fleetmind_version = "0.5.0"
   ```
7. **Apply Terraform** in each consuming fleet:
   ```bash
   terraform apply
   ```
   EC2 instances are replaced; bootstrap installs the new version from public npm.

## Tag-trigger details

The release workflow listens to `v*` tags and only creates a draft release when
the actor is `ggettert`. The npm publish workflow does not run directly from tag
pushes; it runs when Grace publishes the GitHub Release or manually dispatches
the workflow for an existing tag.

For pre-releases (e.g. `v0.6.0-rc.1`), the workflow publishes to the `beta`
dist-tag. Install explicitly with `npm install -g @continuous-agentics/fleetmind@beta`
or `fleetmind self-upgrade --to 0.6.0-rc.1 --apply`.

## Manual workflow_dispatch (debug / rerun)

If you need to re-publish (e.g. a flake after the release was published):

1. Go to `https://github.com/Continuous-Agentics/fleetmind/actions/workflows/publish.yml`
2. Click **Run workflow**
3. Branch: `main` (or the tagged ref)
4. Enter the existing tag, e.g. `v0.10.4`
5. Run

The manual path publishes npm from the requested tag. The GitHub Release usually
already exists.
