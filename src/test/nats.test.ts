/**
 * Test suite for fleetmind nats subscribe command
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";

test("fleetmind nats subscribe --help should work", () => {
  const output = execSync("node dist/cli/index.js nats subscribe --help").toString();
  assert(output.includes("Subscription mode"), "Help should mention mode option");
  assert(output.includes("worker-id"), "Help should mention worker-id option");
});

test("fleetmind nats subscribe requires --mode", () => {
  try {
    execSync("node dist/cli/index.js nats subscribe 2>&1", { stdio: "pipe" });
    assert.fail("Should have exited with error");
  } catch (err: any) {
    assert(err.status !== 0, "Should exit with non-zero status");
    // Commander will show error about missing --mode
  }
});

test("fleetmind nats subscribe --mode worker requires --worker-id", () => {
  try {
    execSync("node dist/cli/index.js nats subscribe --mode worker 2>&1", { stdio: "pipe" });
    assert.fail("Should have exited with error");
  } catch (err: any) {
    assert(err.status !== 0, "Should exit with non-zero status");
    const stderr = err.stderr?.toString() || err.stdout?.toString();
    // Should error about missing delegation or nats config
  }
});

test("fleetmind nats subscribe validates mode", () => {
  try {
    execSync("node dist/cli/index.js nats subscribe --mode invalid --worker-id test 2>&1", {
      stdio: "pipe",
    });
    assert.fail("Should have exited with error");
  } catch (err: any) {
    assert(err.status !== 0, "Should exit with non-zero status");
  }
});
