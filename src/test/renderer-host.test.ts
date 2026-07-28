/**
 * Tests for per-target (per-host) rendering — the basis of the single-gateway
 * local model. Agents that share a `target` render into ONE gateway config;
 * agents on other hosts (and their Slack credentials) are excluded, preserving
 * the per-host credential scoping the AWS slice has.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet, type Fleet } from "../core/model.js";
import { agentsForTarget, renderHostOpenClawJson } from "../runtime/renderer.js";

/** Two hosts: conductor + pixel on mac-1, forge on mac-2. */
function makeFleet(): Fleet {
  const localTarget = () => ({
    provider: "local",
    os: "macos",
    service_manager: "launchd",
  });
  const slack = (id: string) => ({
    provider: "slack",
    account_id: id,
    bot_token: `xoxb-${id}`,
    app_token: `xapp-${id}`,
  });
  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "demo-fleet" },
      targets: {
        "mac-1": localTarget(),
        "mac-2": localTarget(),
      },
      agents: {
        list: [
          { id: "conductor", name: "Conductor", orchestrator: true, target: "mac-1", channels: [slack("conductor")] },
          { id: "pixel", name: "Pixel", target: "mac-1", channels: [slack("pixel")] },
          { id: "forge", name: "Forge", target: "mac-2", channels: [slack("forge")] },
        ],
      },
    })
  );
}

describe("agentsForTarget", () => {
  it("returns only the agents whose target resolves to the host", () => {
    const fleet = makeFleet();
    assert.deepEqual(agentsForTarget(fleet, "mac-1").map((a) => a.id), ["conductor", "pixel"]);
    assert.deepEqual(agentsForTarget(fleet, "mac-2").map((a) => a.id), ["forge"]);
  });
});

describe("renderHostOpenClawJson", () => {
  it("renders one multi-agent gateway for a host with several agents", () => {
    const cfg = renderHostOpenClawJson(makeFleet(), "mac-1");
    const list = (cfg.agents as { list: Array<{ id: string }> }).list;
    assert.deepEqual(list.map((a) => a.id), ["conductor", "pixel"]);

    const bindings = cfg.bindings as Array<{ agentId: string }>;
    assert.deepEqual(bindings.map((b) => b.agentId), ["conductor", "pixel"]);

    const accounts = (cfg.channels as { slack: { accounts: Record<string, unknown> } }).slack.accounts;
    assert.deepEqual(Object.keys(accounts).sort(), ["conductor", "pixel"]);
  });

  it("excludes other hosts' agents AND their Slack credentials", () => {
    const cfg = renderHostOpenClawJson(makeFleet(), "mac-2");
    const list = (cfg.agents as { list: Array<{ id: string }> }).list;
    assert.deepEqual(list.map((a) => a.id), ["forge"]);

    // mac-1 agents' Slack accounts must NOT leak into mac-2's gateway config.
    const accounts = (cfg.channels as { slack: { accounts: Record<string, unknown> } }).slack.accounts;
    assert.deepEqual(Object.keys(accounts), ["forge"]);
    assert.equal(accounts["conductor"], undefined);
  });
});
