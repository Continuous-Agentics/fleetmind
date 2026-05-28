/**
 * Tests for the `delegation.nats` auto-default applied during normalization.
 *
 * Operators routinely omit the `nats:` block thinking "no extra config = use
 * defaults," but the subscriber sees the absent block and exits cleanly,
 * leaving the fleet silently delegation-deaf. NATS is the only supported
 * delegation transport today, so `enabled: true` implies "use NATS"; the
 * normalizer fills in an empty `nats: {}` so the schema defaults
 * (`subject_prefix`, `connect_timeout_ms`, …) and the renderer's Cloud-Map
 * URL derivation take over without the operator having to write the literal
 * line in fleet.yaml.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";

const TARGETS = {
  box: { provider: "local", os: "macos", service_manager: "launchd", workspace_base: "/Users/oc/.openclaw" },
} as const;

const AGENTS = {
  defaults: { target: "box", model: "anthropic/claude-sonnet-4-6" },
  list: [{ id: "solo", name: "Solo", orchestrator: true, target: "box" }],
} as const;

function makeFleet(delegation: Record<string, unknown> | undefined) {
  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "demo" },
      targets: TARGETS,
      agents: AGENTS,
      ...(delegation ? { delegation } : {}),
    })
  );
}

describe("normalizeFleet — delegation.nats auto-default", () => {
  it("fills in nats: {} when delegation.enabled and nats is absent", () => {
    const fleet = makeFleet({
      enabled: true,
      table_name: "demo-tasks",
      s3_bucket: "demo-ledger",
      aws_region: "us-west-2",
    });

    assert.ok(fleet.delegation?.nats, "delegation.nats should be populated");
    // Schema defaults flowed through.
    assert.equal(fleet.delegation?.nats?.subject_prefix, "fleetmind");
    assert.equal(fleet.delegation?.nats?.inbox_prefix, "_INBOX");
    assert.equal(fleet.delegation?.nats?.connect_timeout_ms, 5000);
    assert.equal(fleet.delegation?.nats?.max_reconnect, -1);
    // Servers stays unset on purpose — the renderer derives a Cloud-Map URL
    // from the fleet name at render time.
    assert.equal(fleet.delegation?.nats?.servers, undefined);
  });

  it("does not touch an explicit nats block (operator overrides win)", () => {
    const fleet = makeFleet({
      enabled: true,
      table_name: "demo-tasks",
      s3_bucket: "demo-ledger",
      aws_region: "us-west-2",
      nats: { subject_prefix: "myfleet", servers: ["nats://override:4222"] },
    });
    assert.deepEqual(fleet.delegation?.nats?.servers, ["nats://override:4222"]);
    assert.equal(fleet.delegation?.nats?.subject_prefix, "myfleet");
  });

  it("leaves delegation alone when enabled is false", () => {
    const fleet = makeFleet({ enabled: false });
    assert.equal(fleet.delegation?.nats, undefined);
  });

  it("leaves delegation alone when the block is absent entirely", () => {
    const fleet = makeFleet(undefined);
    assert.equal(fleet.delegation, undefined);
  });
});
