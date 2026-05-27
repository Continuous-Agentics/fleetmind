/**
 * Tests for fallback-model emission in the renderer.
 *
 * OpenClaw's model config is `{ primary, fallbacks? }` and treats an agent
 * model object as strict (no failover) unless it carries its own `fallbacks`
 * (see OpenClaw docs/concepts/model-failover). FleetMind materializes each
 * agent's fallback chain into its model object: the agent's own
 * `fallback_models` when set (including an explicit [] = strict), else the
 * fleet-wide `agents.defaults.fallback_models`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet, type Fleet } from "../core/model.js";
import { renderAgentOpenClawJson, renderOpenClawJson } from "../runtime/renderer.js";

function makeFleet(opts: {
  defaultsFallbacks?: string[];
  conductorFallbacks?: string[];
} = {}): Fleet {
  const conductor: Record<string, unknown> = { id: "conductor", name: "Conductor", orchestrator: true };
  if (opts.conductorFallbacks !== undefined) conductor.fallback_models = opts.conductorFallbacks;

  const defaults: Record<string, unknown> = { target: "host", model: "anthropic/claude-sonnet-4-6" };
  if (opts.defaultsFallbacks !== undefined) defaults.fallback_models = opts.defaultsFallbacks;

  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "demo-fleet" },
      targets: {
        host: {
          provider: "aws-ssm",
          os: "linux",
          service_manager: "systemd",
          workspace_base: "/home/ec2-user/.openclaw",
          aws: { region: "us-west-2" },
        },
      },
      agents: { defaults, list: [conductor, { id: "forge", name: "Forge" }] },
    })
  );
}

/** The conductor's model object from the per-agent openclaw.json. */
function conductorModel(fleet: Fleet): { primary: string; fallbacks?: string[] } {
  const cfg = renderAgentOpenClawJson(fleet, "conductor");
  const list = (cfg.agents as { list: Array<{ id: string; model: { primary: string; fallbacks?: string[] } }> }).list;
  return list.find((a) => a.id === "conductor")!.model;
}

function defaultsModel(fleet: Fleet): { primary: string; fallbacks?: string[] } {
  const cfg = renderAgentOpenClawJson(fleet, "conductor");
  return (cfg.agents as { defaults: { model: { primary: string; fallbacks?: string[] } } }).defaults.model;
}

describe("renderer model fallbacks", () => {
  it("omits fallbacks entirely when none are configured (strict)", () => {
    const m = conductorModel(makeFleet());
    assert.equal(m.primary, "anthropic/claude-sonnet-4-6");
    assert.equal(m.fallbacks, undefined);
  });

  it("materializes fleet-default fallbacks into the agent model + defaults", () => {
    const fleet = makeFleet({ defaultsFallbacks: ["openai/gpt-4o", "google/gemini-2.0-flash"] });
    assert.deepEqual(conductorModel(fleet).fallbacks, ["openai/gpt-4o", "google/gemini-2.0-flash"]);
    assert.deepEqual(defaultsModel(fleet).fallbacks, ["openai/gpt-4o", "google/gemini-2.0-flash"]);
  });

  it("lets a per-agent fallback list override the fleet default", () => {
    const fleet = makeFleet({
      defaultsFallbacks: ["openai/gpt-4o"],
      conductorFallbacks: ["anthropic/claude-haiku-4-5"],
    });
    assert.deepEqual(conductorModel(fleet).fallbacks, ["anthropic/claude-haiku-4-5"]);
  });

  it("treats an explicit empty per-agent list as strict, even with a fleet default", () => {
    const fleet = makeFleet({ defaultsFallbacks: ["openai/gpt-4o"], conductorFallbacks: [] });
    assert.equal(conductorModel(fleet).fallbacks, undefined, "empty list → no fallbacks emitted");
    // The fleet default still applies to agents that didn't opt out (forge).
    const full = renderOpenClawJson(fleet);
    const forge = (full.agents as { list: Array<{ id: string; model: { fallbacks?: string[] } }> }).list
      .find((a) => a.id === "forge")!;
    assert.deepEqual(forge.model.fallbacks, ["openai/gpt-4o"]);
  });
});
