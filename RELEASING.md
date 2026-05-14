# Releasing fleetmind

fleetmind is published to GitHub Packages as `@continuous-agentics/fleetmind`.

## Prerequisites

### npm auth setup (one-time, per-machine)

Generate a classic PAT from https://github.com/settings/tokens with:
- `read:packages` scope (for installing)
- `write:packages` scope (for publishing)

Then configure your local npm:

```bash
echo "@continuous-agentics:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=<YOUR_PAT>" >> ~/.npmrc
```

After this, `npm install -g @continuous-agentics/fleetmind` works locally.

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
   - Publishes to GitHub Packages (`@continuous-agentics/fleetmind`)
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
   EC2 instances are replaced; STAGE 6b of the bootstrap installs the new version from GitHub Packages.

## Post-merge order for PR #59

> **Important:** The bootstrap STAGE 6b will fail until fleetmind is published and the SSM token is in place. Do this in order after merging:

1. **Merge PR #59** into `test/gg-sandbox`.
2. **Put the GitHub PAT in SSM:**
   ```bash
   aws ssm put-parameter \
     --name /fleetmind/shared/github-packages-token \
     --type SecureString \
     --value <PAT_WITH_READ_PACKAGES> \
     --region us-west-2
   ```
   The PAT needs `read:packages` scope at minimum.
3. **Publish the package** (one-time; run from a machine with `write:packages`):
   ```bash
   # Ensure ~/.npmrc is configured (see Prerequisites above)
   npm version 0.4.1   # or skip if package.json already has 0.4.1
   npm publish
   ```
4. **Apply Terraform** — instances are replaced; STAGE 6b fetches the PAT from SSM,
   installs `@continuous-agentics/fleetmind@0.4.1`, verifies `fleetmind --version`,
   and cleans up the `.npmrc`.

## SSM parameter path

```
/fleetmind/shared/github-packages-token
```

Type: `SecureString` (encrypted with the default SSM KMS key `aws/ssm`).

All fleets and all agent instances share this one parameter. Single point of revocation — rotate by overwriting the parameter.

## Tag-trigger details

The publish workflow's tag filter is strict semver: `v[0-9]+.[0-9]+.[0-9]+`. Typo'd tags (`v0.5.2.` or `v0.5-rc`) do **not** trigger a publish — they push to the repo as ordinary tags but no workflow fires.

For pre-releases (e.g. `v0.6.0-rc.1`): the current filter does not include `-rc` suffixes. To publish a pre-release, run the workflow manually via `workflow_dispatch` with `confirm=publish` against the branch/tag of choice. We can broaden the regex if pre-releases become routine — file an issue.

## Manual workflow_dispatch (debug / rerun)

If you need to re-publish (e.g. a flake in the original tag-push run):

1. Go to `https://github.com/Continuous-Agentics/fleetmind/actions/workflows/publish.yml`
2. Click **Run workflow**
3. Branch: `main` (or the tagged ref)
4. Type `publish` in the `confirm` input
5. Run

The manual path skips the auto-create-GitHub-Release step (the release usually already exists).
