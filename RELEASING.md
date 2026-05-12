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
2. **Bump version:**
   ```bash
   npm version minor   # or patch/major as appropriate
   ```
   This updates `package.json` and creates a git tag (e.g. `v0.5.0`).
3. **Push tags:**
   ```bash
   git push && git push --tags
   ```
4. **Publish:**
   ```bash
   npm publish
   ```
   This publishes `@continuous-agentics/fleetmind` to GitHub Packages at the new version.
5. **Update infra:**
   Edit `infra/terraform/terraform-extras.tfvars`:
   ```hcl
   fleetmind_version = "0.5.0"   # match whatever you just published
   ```
6. **Apply Terraform:**
   ```bash
   terraform apply
   ```
   EC2 instances are replaced; STAGE 6b of the bootstrap installs the new version.

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
   npm version 0.4.0   # or skip if package.json already has 0.4.0
   npm publish
   ```
4. **Apply Terraform** — instances are replaced; STAGE 6b fetches the PAT from SSM,
   installs `@continuous-agentics/fleetmind@0.4.0`, verifies `fleetmind --version`,
   and cleans up the `.npmrc`.

## SSM parameter path

```
/fleetmind/shared/github-packages-token
```

Type: `SecureString` (encrypted with the default SSM KMS key `aws/ssm`).

All fleets and all agent instances share this one parameter. Single point of revocation — rotate by overwriting the parameter.

## Future: automate via GitHub Actions

Not needed for v0.x. Manual publish is fine. A GitHub Actions workflow triggered on
`v*` tag push can run `npm publish` and update the tfvars automatically.
