/**
 * Smoke test for `fleetmind init`.
 *
 * The v1→v2 clean break broke init silently: it scaffolded a fleet.yaml that
 * could no longer load (no `targets:`, agent-level `slack:` instead of
 * `channels:`, `workspace_base` on agents.defaults). tsc can't catch that — the
 * template is a string. This test renders the real template and round-trips it
 * through loadFleet/normalizeFleet so a freshly-init'd fleet is guaranteed to
 * load.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import { renderInitTemplate } from "../cli/commands/init.js";
import { loadFleet } from "../config/loader.js";

let tmpDir: string;

describe("fleetmind init template", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-init-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("scaffolded fleet.yaml loads + normalizes (target resolves)", () => {
    const content = renderInitTemplate("acme-bots", "Acme Corp");
    const fleetPath = path.join(tmpDir, "fleet.yaml");
    fs.writeFileSync(fleetPath, content, "utf-8");

    const fleet = loadFleet(fleetPath);

    assert.equal(fleet.fleet.name, "acme-bots");
    assert.equal(fleet.fleet.client, "Acme Corp");

    // The whole point of the regression: every agent must resolve a target.
    const conductor = fleet.getAgent("conductor");
    assert.ok(conductor, "conductor agent should exist");
    const target = fleet.targetForAgent(conductor!);
    assert.equal(target.id, "conductor-host");
    assert.equal(target.provider, "aws-ssm");

    // v2 channels (not the v1 agent-level `slack:` block).
    assert.equal(conductor!.channels.length, 1);
    assert.equal(conductor!.channels[0]!.provider, "slack");

    // Orchestrator accessor works.
    assert.equal(fleet.orchestrator?.id, "conductor");
  });

  test("placeholder name substitution leaves no {NAME}/{CLIENT} tokens", () => {
    const content = renderInitTemplate("my-fleet", "my-fleet");
    assert.ok(!content.includes("{NAME}"), "{NAME} should be substituted");
    assert.ok(!content.includes("{CLIENT}"), "{CLIENT} should be substituted");
  });
});
