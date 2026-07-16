import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet, type Fleet } from "../core/model.js";
import { renderAgentOpenClawJson, renderHostOpenClawJson } from "../runtime/renderer.js";

function makeFleet(): Fleet {
  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "demo" },
      targets: {
        box: {
          provider: "local",
          os: "macos",
          service_manager: "launchd",
          workspace_base: "/Users/oc/.openclaw",
        },
      },
      agents: {
        defaults: { target: "box", model: "anthropic/claude-sonnet-4-6" },
        list: [{ id: "solo", name: "Solo", orchestrator: true }],
      },
    })
  );
}

function agentDefaults(cfg: Record<string, unknown>): Record<string, unknown> {
  return (cfg.agents as { defaults: Record<string, unknown> }).defaults;
}

function assertContextSafetyDefaults(defaults: Record<string, unknown>): void {
  assert.deepEqual(defaults.contextLimits, {
    toolResultMaxChars: 6000,
  });
  assert.deepEqual(defaults.contextPruning, {
    mode: "cache-ttl",
    ttl: "90s",
  });
  assert.deepEqual(defaults.compaction, {
    reserveTokens: 60000,
    maxHistoryShare: 0.35,
    recentTurnsPreserve: 2,
    midTurnPrecheck: {
      enabled: true,
    },
    truncateAfterCompaction: true,
  });
  assert.deepEqual(defaults.subagents, {
    archiveAfterMinutes: 15,
  });
}

describe("renderer OpenClaw context safety defaults", () => {
  it("emits tighter context defaults for per-agent configs", () => {
    assertContextSafetyDefaults(agentDefaults(renderAgentOpenClawJson(makeFleet(), "solo")));
  });

  it("emits tighter context defaults for per-host configs", () => {
    assertContextSafetyDefaults(agentDefaults(renderHostOpenClawJson(makeFleet(), "box")));
  });
});
