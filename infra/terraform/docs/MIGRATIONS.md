# Migrations

Per-version notes on what callers need to do when bumping `?ref=` in their `main.tf`. The format for each entry:

- **Breaking changes** — variables removed/renamed, outputs renamed, resource addresses changed (require state mv or apply will recreate).
- **New optional variables** — additions you can adopt at your own pace.
- **Behavioral changes** — module logic differences that don't change the API but might surprise you in `terraform plan`.

If your `terraform plan` after a version bump shows unexpected destroy+create on resources you don't want destroyed, *stop and read the matching entry below* before applying.

---

## v1.1.1 (current v1 baseline)

### Behavioral changes

- Agent bootstrap installs `@continuous-agentics/fleetmind` from public npm.
- The per-agent IAM role no longer includes the shared `/fleetmind/shared/github-packages-token` SSM read policy.

### Operator action

Use this module with FleetMind CLI `0.10.1` or newer and a `fleetmind-template` baseline that no longer requires GitHub Packages setup.

```hcl
module "fleetmind" {
  source = "github.com/Continuous-Agentics/terraform-aws-fleetmind?ref=v1.1.1"
  ...
}
```

Then run:

```bash
terraform init -upgrade
terraform plan
```

Expect instance replacement if your existing launch templates/user data were created from a GitHub-Packages bootstrap version.

---

## v0.1.6

The first entry baseline. No migration from a previous version is documented here yet because v0.1.x is the first tagged minor series — operators consuming pre-v0.1.0 commits were on `?ref=main`, not on a tag, and are expected to bump to `?ref=v0.1.6` cleanly without state surgery.

**To bump from `?ref=main` to `?ref=v0.1.6`:**

```hcl
module "fleetmind" {
- source = "github.com/Continuous-Agentics/terraform-aws-fleetmind"
+ source = "github.com/Continuous-Agentics/terraform-aws-fleetmind?ref=v0.1.6"
  ...
}
```

Then `terraform init -upgrade && terraform plan`. Expect zero changes if you were on a recent `main`.

---

## Future entries

When `v0.2.0` (or higher) ships, this doc will gain a top entry covering what changed. Operators on a `v0.1.x` pin can read that entry, decide whether to upgrade, and follow the documented migration path. Until then, this stub is a placeholder so the cross-links resolve.

---

## Conventions

- **Patch (`v0.1.x`):** No breaking changes. Variable additions allowed if defaulted to backward-compatible behavior.
- **Minor (`v0.x.0`):** May include breaking changes; each must have a migration entry below.
- **Major (`vx.0.0`):** Module-shape changes (new submodules, removed submodules, large input renames). Migration entries are mandatory.
