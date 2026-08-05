import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AgentSchema } from "../config/schema.js";

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
