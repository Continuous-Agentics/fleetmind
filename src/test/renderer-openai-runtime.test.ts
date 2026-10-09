/** Regression coverage for typed OpenClaw per-model runtime policy. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet, type Fleet } from "../core/model.js";
import {
  renderHostOpenClawJson,
  renderAgentOpenClawJson,
} from "../runtime/renderer.js";

type ModelOverride = {
  params?: { cacheRetention?: string };
  agentRuntime?: { id: string };
};
type ModelsMap = Record<string, ModelOverride>;

function makeFleet(
  opts: {
    defaultsModel?: string;
    defaultsFallbacks?: string[];
    defaultsModels?: ModelsMap;
    agents?: Array<Record<string, unknown>>;
  } = {},
): Fleet {
  const agents = opts.agents ?? [
    { id: "solo", name: "Solo", orchestrator: true, target: "box" },
  ];
  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "demo" },
      targets: {
        box: { provider: "local", os: "macos", service_manager: "launchd" },
        other: { provider: "local", os: "linux", service_manager: "none" },
      },
      agents: {
        defaults: {
          target: "box",
          model: opts.defaultsModel ?? "anthropic/claude-sonnet-4-6",
          ...(opts.defaultsFallbacks
            ? { fallback_models: opts.defaultsFallbacks }
            : {}),
          ...(opts.defaultsModels ? { models: opts.defaultsModels } : {}),
        },
        list: agents,
      },
    }),
  );
}

function configModels(cfg: Record<string, unknown>): {
  defaults?: ModelsMap;
  entries: Record<
    string,
    { models?: ModelsMap; model: { primary: string; fallbacks?: string[] } }
  >;
} {
  const agents = cfg.agents as {
    defaults: { models?: ModelsMap };
    entries: Record<
      string,
      { models?: ModelsMap; model: { primary: string; fallbacks?: string[] } }
    >;
  };
  return { defaults: agents.defaults.models, entries: agents.entries };
}

describe("renderer openai agentRuntime routing", () => {
  it("keeps the automatic OpenClaw default when no explicit override exists", () => {
    const fleet = makeFleet({
      agents: [
        { id: "solo", name: "Solo", model: "openai/gpt-5.5", target: "box" },
      ],
    });
    for (const rendered of [
      renderHostOpenClawJson(fleet, "box"),
      renderAgentOpenClawJson(fleet, "solo"),
    ]) {
      const models = configModels(rendered);
      assert.deepEqual(models.defaults?.["openai/gpt-5.5"]?.agentRuntime, {
        id: "openclaw",
      });
      assert.equal(models.entries.solo.models, undefined);
    }
  });

  it("applies the automatic default to OpenAI fallback models without changing strict/fallback model shape", () => {
    const fleet = makeFleet({
      defaultsFallbacks: ["openai/gpt-5.4-mini"],
      agents: [
        { id: "inherit", name: "Inherit", target: "box" },
        { id: "strict", name: "Strict", target: "box", fallback_models: [] },
      ],
    });
    const models = configModels(renderHostOpenClawJson(fleet, "box"));
    assert.deepEqual(models.defaults?.["openai/gpt-5.4-mini"]?.agentRuntime, {
      id: "openclaw",
    });
    assert.deepEqual(models.entries.inherit.model.fallbacks, [
      "openai/gpt-5.4-mini",
    ]);
    assert.equal(models.entries.strict.model.fallbacks, undefined);
  });

  it("preserves a fleet-wide explicit wildcard runtime and model params", () => {
    const fleet = makeFleet({
      defaultsModel: "openai/gpt-5.5",
      defaultsModels: {
        "openai/*": { agentRuntime: { id: "codex" } },
        "openai/gpt-5.5": { params: { cacheRetention: "short" } },
      },
    });
    const models = configModels(renderAgentOpenClawJson(fleet, "solo"));
    assert.deepEqual(models.defaults?.["openai/*"]?.agentRuntime, {
      id: "codex",
    });
    assert.deepEqual(models.defaults?.["openai/gpt-5.5"]?.params, {
      cacheRetention: "short",
    });
    assert.equal(models.defaults?.["openai/gpt-5.5"]?.agentRuntime, undefined);
  });

  it("emits per-agent wildcard/exact Codex runtime without cross-agent or cross-host leakage", () => {
    const fleet = makeFleet({
      defaultsModel: "openai/gpt-5.5",
      agents: [
        {
          id: "wren",
          name: "Wren",
          target: "box",
          fallback_models: ["openai/gpt-5.6"],
          models: {
            "openai/*": { agentRuntime: { id: "codex" } },
            "openai/gpt-5.6": {
              agentRuntime: { id: "codex" },
              params: { cacheRetention: "long" },
            },
          },
        },
        { id: "robin", name: "Robin", target: "box" },
        { id: "finch", name: "Finch", target: "other" },
      ],
    });
    const host = configModels(renderHostOpenClawJson(fleet, "box"));
    assert.deepEqual(host.entries.wren.models?.["openai/*"]?.agentRuntime, {
      id: "codex",
    });
    assert.deepEqual(host.entries.wren.models?.["openai/gpt-5.6"], {
      agentRuntime: { id: "codex" },
      params: { cacheRetention: "long" },
    });
    assert.deepEqual(
      host.entries.robin.models?.["openai/gpt-5.5"]?.agentRuntime,
      { id: "openclaw" },
    );
    assert.equal(host.defaults?.["openai/gpt-5.5"]?.agentRuntime, undefined);
    assert.equal(host.entries.finch, undefined);

    const otherHost = configModels(renderHostOpenClawJson(fleet, "other"));
    assert.deepEqual(otherHost.defaults?.["openai/gpt-5.5"]?.agentRuntime, {
      id: "openclaw",
    });
    assert.deepEqual(Object.keys(otherHost.entries), ["finch"]);

    const wren = configModels(renderAgentOpenClawJson(fleet, "wren"));
    assert.deepEqual(wren.entries.wren.models?.["openai/*"]?.agentRuntime, {
      id: "codex",
    });
    assert.equal(wren.entries.robin, undefined);
    const robin = configModels(renderAgentOpenClawJson(fleet, "robin"));
    assert.deepEqual(robin.defaults?.["openai/gpt-5.5"]?.agentRuntime, {
      id: "openclaw",
    });
    assert.equal(robin.entries.robin.models, undefined);
  });

  it("accepts only typed runtime/params fields and non-empty runtime ids", () => {
    const base = {
      fleet: { name: "demo" },
      targets: { box: { provider: "local" } },
      agents: {
        defaults: { target: "box" },
        list: [{ id: "solo", name: "Solo", target: "box" }],
      },
    };
    assert.throws(
      () =>
        FleetSchema.parse({
          ...base,
          agents: {
            ...base.agents,
            defaults: {
              target: "box",
              models: { "openai/*": { agentRuntime: { id: "" } } },
            },
          },
        }),
      /agentRuntime\.id must not be empty/,
    );
    assert.throws(
      () =>
        FleetSchema.parse({
          ...base,
          agents: {
            ...base.agents,
            list: [
              {
                id: "solo",
                name: "Solo",
                target: "box",
                models: { "openai/*": { arbitrary: true } },
              },
            ],
          },
        }),
      /Unrecognized key/,
    );
  });

  it("emits no models map for an Anthropic-only fleet", () => {
    const fleet = makeFleet();
    const models = configModels(renderHostOpenClawJson(fleet, "box"));
    assert.equal(models.defaults, undefined);
    assert.equal(models.entries.solo.models, undefined);
  });
});
