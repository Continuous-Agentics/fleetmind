import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { AgentSchema } from "../config/schema.js";
import { normalizeGithubAppsInFleetYaml } from "../cli/commands/render.js";

describe("explicit GitHub App declarations", () => {
  test("accepts project: {} and named Apps with explicit owner/type", () => {
    const agent = AgentSchema.parse({
      id: "wren", name: "Wren",
      github_apps: {
        project: {},
        "client-prod": { owner: "acme", org: true, permissions: { contents: "write" }, events: ["push"] },
      },
    });
    assert.deepEqual(agent.github_apps, {
      project: {},
      "client-prod": { owner: "acme", org: true, permissions: { contents: "write" }, events: ["push"] },
    });
  });

  test("rejects ambiguous named Apps and project ownership", () => {
    for (const github_apps of [
      { client: { owner: "acme" } },
      { client: { org: true } },
      { project: { owner: "acme", org: true } },
      { client: { owner: "bad/name", org: true } },
      { client: { owner: "acme", org: true, typo: true } },
    ]) {
      assert.throws(() => AgentSchema.parse({ id: "wren", name: "Wren", github_apps }));
    }
  });

  test("rejects duplicate or blank events and mixed legacy controls", () => {
    assert.throws(() => AgentSchema.parse({
      id: "wren", name: "Wren", github_apps: { project: { events: ["push", "push"] } },
    }));
    assert.throws(() => AgentSchema.parse({
      id: "wren", name: "Wren", github_apps: { project: { events: [""] } },
    }));
    assert.throws(() => AgentSchema.parse({
      id: "wren", name: "Wren", github_access: true, github_apps: { project: {} },
    }));
  });
});

describe("GitHub App render migration", () => {
  test("writes explicit project once and is idempotent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-github-apps-"));
    const file = path.join(dir, "fleet.yaml");
    fs.writeFileSync(file, "agents:\n  list:\n    # retained comment\n    - id: wren\n      name: Wren\n      github_access: true\n");
    assert.equal(normalizeGithubAppsInFleetYaml(file), true);
    const migrated = fs.readFileSync(file, "utf8");
    assert.match(migrated, /github_apps:\n\s+project: \{\}/);
    assert.doesNotMatch(migrated, /github_access/);
    assert.equal(normalizeGithubAppsInFleetYaml(file), false);
    assert.equal(fs.readFileSync(file, "utf8"), migrated);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("migrates legacy false to an explicit empty map without project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-github-apps-"));
    const file = path.join(dir, "fleet.yaml");
    fs.writeFileSync(file, "agents:\n  list:\n    - id: wren\n      name: Wren\n      github_access: false\n");
    normalizeGithubAppsInFleetYaml(file);
    const migrated = fs.readFileSync(file, "utf8");
    assert.match(migrated, /github_apps: \{\}/);
    assert.doesNotMatch(migrated, /project/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
