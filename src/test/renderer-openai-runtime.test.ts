/**
 * Tests for OpenAI agent-runtime routing in the renderer.
 *
 * OpenClaw routes `openai/*` models to the Codex (subscription/OAuth) harness by
 * default; to bill against an injected OPENAI_API_KEY the model must carry
 * `agentRuntime: { id: "openclaw" }` (see OpenClaw docs/providers/openai). The
 * renderer emits that override for every openai/* model a fleet uses — primary
 * or fallback — in both render paths, and leaves other providers untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet, type Fleet } from "../core/model.js";
import { renderHostOpenClawJson, renderAgentOpenClawJson } from "../runtime/renderer.js";

function makeFleet(opts: { model?: string; fallbacks?: string[] }): Fleet {
  const agent: Record<string, unknown> = { id: "solo", name: "Solo", orchestrator: true, target: "box" };
  if (opts.model) agent.model = opts.model;
  if (opts.fallbacks) agent.fallback_models = opts.fallbacks;
  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "demo" },
      targets: { box: { provider: "local", os: "macos", service_manager: "launchd" } },
      agents: { defaults: { target: "box", model: "anthropic/claude-sonnet-4-6" }, list: [agent] },
    })
  );
}

function defaultsModels(cfg: Record<string, unknown>): Record<string, { agentRuntime?: { id: string } }> | undefined {
  return (cfg.agents as { defaults: { models?: Record<string, { agentRuntime?: { id: string } }> } }).defaults.models;
}

describe("renderer openai agentRuntime routing", () => {
  it("forces the openclaw runtime for an openai primary model (per-host + per-agent paths)", () => {
    const fleet = makeFleet({ model: "openai/gpt-5.5" });

    const host = defaultsModels(renderHostOpenClawJson(fleet, "box"));
    assert.deepEqual(host?.["openai/gpt-5.5"]?.agentRuntime, { id: "openclaw" });

    const slice = defaultsModels(renderAgentOpenClawJson(fleet, "solo"));
    assert.deepEqual(slice?.["openai/gpt-5.5"]?.agentRuntime, { id: "openclaw" });
  });

  it("also overrides an openai model used only as a fallback", () => {
    const fleet = makeFleet({ model: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.4-mini"] });
    const host = defaultsModels(renderHostOpenClawJson(fleet, "box"));
    assert.deepEqual(host?.["openai/gpt-5.4-mini"]?.agentRuntime, { id: "openclaw" });
    // The anthropic primary is NOT given a runtime override.
    assert.equal(host?.["anthropic/claude-sonnet-4-6"], undefined);
  });

  it("emits no models map for an anthropic-only fleet", () => {
    const fleet = makeFleet({ model: "anthropic/claude-sonnet-4-6" });
    assert.equal(defaultsModels(renderHostOpenClawJson(fleet, "box")), undefined);
    assert.equal(defaultsModels(renderAgentOpenClawJson(fleet, "solo")), undefined);
  });
});
