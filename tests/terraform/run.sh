#!/usr/bin/env bash
# Run Terraform's plan-time test suite from a disposable local module copy.
# Terraform requires .tftest.hcl files to be local to the configuration being
# tested; keeping the canonical tests at tests/terraform preserves the project
# layout without polluting infra/terraform with CI artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fleetmind-terraform-tests.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

tar \
  --exclude=.terraform \
  --exclude=.terraform.lock.hcl \
  -C "$ROOT/infra/terraform/modules/fleetmind" \
  -cf - . | tar -C "$TEMP_DIR" -xf -

mkdir -p "$TEMP_DIR/tests"
cp "$ROOT/tests/terraform/plan.tftest.hcl" "$TEMP_DIR/tests/"
terraform -chdir="$TEMP_DIR" init -backend=false -input=false >/dev/null
terraform -chdir="$TEMP_DIR" test
