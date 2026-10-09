import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { renderAgentOpenClawJson, renderHostOpenClawJson } from "../runtime/renderer.js";
import { mergeCanonicalConfigs, normalizeOpenClawConfig, publishOpenClawConfig, assertSupportedNode, validateOpenClawCandidate } from "../runtime/openclaw-config.js";
import { applyDiff } from "../cli/commands/pull-self.js";
import { CONFIG_STAGING_PREFIX } from "../cli/commands/push-fleet.js";

function fleet(plugins?: { allow?: string[]; deny?: string[] }, selfManaged = false) {
  return normalizeFleet(FleetSchema.parse({ fleet: { name: "compat" },
    targets: { box: { provider: "local", os: "linux" } },
    openclaw: { plugins, tools: { web_search: { enabled: false } },
      ...(selfManaged ? { self_managed_updates: { enabled: true, channel: "extended-stable" } } : {}) },
    agents: { defaults: { target: "box" }, list: [
      { id: "alpha", name: "Alpha", model: "openai/gpt-5.5", plugins: ["custom"], orchestrator: true },
      { id: "beta", name: "Beta" },
    ] } }));
}

function wrenCodexFleet() {
  return normalizeFleet(FleetSchema.parse({
    fleet: { name: "wren-runtime" },
    targets: { box: { provider: "local", os: "linux" } },
    openclaw: { tools: { web_search: { enabled: false } } },
    agents: { defaults: { target: "box", model: "openai/gpt-5.5" }, list: [{
      id: "wren",
      name: "Wren",
      orchestrator: true,
      models: { "openai/*": { agentRuntime: { id: "codex" } } },
    }] },
  }));
}

describe("current OpenClaw contract", () => {
  it("renders the supported per-agent Wren runtime requirement shape", () => {
    for (const config of [renderAgentOpenClawJson(wrenCodexFleet(), "wren"), renderHostOpenClawJson(wrenCodexFleet(), "box")]) {
      const c = config as any;
      assert.equal(c.agents.entries.wren.models["openai/*"].agentRuntime.id, "codex");
      assert.equal(c.agents.defaults.models?.["openai/gpt-5.5"]?.agentRuntime, undefined);
      assert.ok(c.plugins.allow.includes("codex"));
    }
  });

  it("both render paths derive selected provider/custom allowlists and honor denies", () => {
    for (const config of [renderAgentOpenClawJson(fleet(), "alpha"), renderHostOpenClawJson(fleet(), "box")]) {
      const c = config as any;
      assert.equal(c.agents.list, undefined);
      assert.equal(c.agents.entries.alpha.id, undefined);
      assert.equal(c.agents.entries.alpha.default, undefined);
      assert.ok(c.plugins.allow.includes("openai"));
      assert.ok(c.plugins.allow.includes("custom"));
      assert.ok(!c.plugins.allow.includes("codex")); // embedded runtime, not a subscription fallback
    }
    for (const config of [renderAgentOpenClawJson(fleet({ deny: ["openai", "custom"] }), "alpha"),
      renderHostOpenClawJson(fleet({ allow: ["slack", "custom"], deny: ["custom"] }), "box")]) {
      const c = config as any;
      assert.ok(!c.plugins.allow.includes("openai"));
      assert.ok(!c.plugins.allow.includes("custom"));
      assert.equal(c.plugins.entries.custom.enabled, false);
    }
    const c = renderHostOpenClawJson(fleet(), "box") as any;
    assert.notEqual(c.agents.entries.alpha.agentDir, c.agents.entries.beta.agentDir);
    assert.equal(c.auth, undefined, "renderer must not pretend profile metadata provisions credentials");
    assert.ok(!JSON.stringify(c).includes("OPENAI_API_KEY"), "provider secrets are not rendered inline");
    assert.equal(c.agents.defaults.systemAgent.agentId, "alpha");
    assert.deepEqual(c.bindings, [], "channel-less agents have no authored route");
  });

  it("legacy base + migrated live + current incoming migrate twice without losing unmanaged leaves", () => {
    const base = { agents: { list: [{ id: "alpha", default: true, workspace: "/old", model: "anthropic/old" }] },
      gateway: { port: 1, bind: "loopback" }, plugins: { allow: ["slack"] }, bindings: [{ agentId: "alpha", match: { channel: "slack", accountId: "alpha" } }] };
    const live = normalizeOpenClawConfig(base);
    live.agents.entries.alpha.memory = { search: { enabled: false } };
    live.auth = { profiles: { "openai:operator": { provider: "openai", mode: "api_key" } }, order: { openai: ["openai:operator"] } };
    live.plugins.deny = ["custom"];
    live.gateway.port = 99;
    const incoming = normalizeOpenClawConfig(base);
    incoming.agents.entries.alpha.workspace = "/new";
    incoming.agents.entries.alpha.model = "openai/gpt-5.5";
    incoming.gateway.bind = "lan";
    const once = mergeCanonicalConfigs(incoming, live, base); delete once._patched;
    const twice = mergeCanonicalConfigs(incoming, once, incoming); delete twice._patched;
    assert.deepEqual(twice, once);
    assert.equal(once.agents.entries.alpha.workspace, "/new");
    assert.equal(once.agents.entries.alpha.model, "openai/gpt-5.5");
    assert.equal(once.gateway.bind, "lan");
    assert.equal(once.gateway.port, 99);
    assert.deepEqual(once.auth, live.auth);
    assert.deepEqual(once.plugins.deny, ["custom"]);
    assert.deepEqual(once.agents.entries.alpha.memory, live.agents.entries.alpha.memory);
    assert.equal(once.agents.list, undefined);
  });

  it("first sync preserves unmanaged live settings while adopting new managed settings", () => {
    const c = mergeCanonicalConfigs({ agents: { entries: { a: { model: "openai/gpt-5.5" } } }, plugins: { allow: ["openai"] } },
      { auth: { order: { openai: ["openai:existing"] } }, agents: { entries: { a: { tools: { profile: "coding" } } } } });
    assert.deepEqual(c.plugins.allow, ["openai"]);
    assert.deepEqual(c.auth.order.openai, ["openai:existing"]);
    assert.equal(c.agents.entries.a.tools.profile, "coding");
    const numeric = normalizeOpenClawConfig({ agents: { list: [{ id: "7" }, { id: "2" }] }, channels: { slack: {} } });
    assert.equal(numeric.bindings[0].agentId, "7");
    assert.equal(numeric.agents.defaults.systemAgent, undefined, "no invented ambient owner when legacy roster has neither default nor main");
  });

  it("preserves legacy implicit channel ownership and rejects conflicting identities", () => {
    const c = normalizeOpenClawConfig({ agents: { list: [{ id: "7" }, { id: "2", default: true }] },
      channels: { defaults: { groupPolicy: "allowlist" }, slack: { accounts: { work: {} } } } });
    assert.deepEqual(Object.keys(c.agents.entries).sort(), ["2", "7"]);
    assert.equal(c.bindings[0].agentId, "2");
    assert.equal(c.bindings.length, 1, "channel defaults are not an account to route");
    assert.equal(c.agents.defaults.systemAgent.agentId, "2");
    assert.throws(() => normalizeOpenClawConfig({ agents: { list: [{ id: "a" }, { id: "a" }] } }), /duplicate/);
    assert.throws(() => normalizeOpenClawConfig({ agents: { list: [{ id: "a" }], entries: { b: {} } } }), /Conflicting/);
  });

  it("invalid candidate preserves config AND baseline bytes even when baseline is added first", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-publication-"));
    try {
      const staging = path.join(root, "staging"); const cfg = path.join(root, "cfg");
      fs.mkdirSync(path.join(staging, CONFIG_STAGING_PREFIX), { recursive: true }); fs.mkdirSync(cfg);
      fs.writeFileSync(path.join(cfg, "openclaw.json"), '{ "gateway": { "port": 123 } }\n');
      fs.writeFileSync(path.join(cfg, "openclaw.base.json"), '{}\n');
      const before = fs.readFileSync(path.join(cfg, "openclaw.json"));
      for (const name of ["openclaw.base.json", "openclaw.json"]) fs.writeFileSync(path.join(staging, CONFIG_STAGING_PREFIX, name), '{"invalid":true}');
      assert.throws(() => applyDiff(staging, path.join(root, "workspace"), {
        added: ["openclaw.base.json", "openclaw.json"].map((name) => ({ path: `${CONFIG_STAGING_PREFIX}/${name}`, size: 1, sha256: "x", mode: 0o600 })), modified: [], deleted: [],
      }, cfg, () => { throw new Error("fixture invalid"); }), /fixture invalid/);
      assert.deepEqual(fs.readFileSync(path.join(cfg, "openclaw.json")), before);
      assert.equal(fs.readFileSync(path.join(cfg, "openclaw.base.json"), "utf8"), '{}\n');
      publishOpenClawConfig(path.join(cfg, "openclaw.json"), { agents: { entries: { a: {} } } }, () => {});
      assert.equal(fs.statSync(path.join(cfg, "openclaw.json")).mode & 0o777, 0o600);
      assert.throws(() => publishOpenClawConfig(path.join(cfg, "openclaw.json"), {}, () => {
        fs.writeFileSync(path.join(cfg, "openclaw.json"), "operator-edited-during-validation");
      }), /changed during validation/);
      assert.equal(fs.readFileSync(path.join(cfg, "openclaw.json"), "utf8"), "operator-edited-during-validation");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("reconciles a changed baseline even when the staged config itself is unchanged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-baseline-replay-"));
    try {
      const staged = path.join(root, "staging", CONFIG_STAGING_PREFIX);
      const cfg = path.join(root, "cfg"); fs.mkdirSync(staged, { recursive: true }); fs.mkdirSync(cfg);
      const incoming = { agents: { entries: { a: { name: "A" } } } };
      fs.writeFileSync(path.join(staged, "openclaw.json"), JSON.stringify(incoming));
      fs.writeFileSync(path.join(cfg, "openclaw.json"), JSON.stringify(incoming));
      fs.writeFileSync(path.join(cfg, "openclaw.base.json"), JSON.stringify({ agents: { list: [{ id: "a", name: "A" }] } }));
      let checks = 0;
      applyDiff(path.join(root, "staging"), path.join(root, "ws"), {
        added: [], deleted: [], modified: [{ currentSize: 1, incoming: { path: `${CONFIG_STAGING_PREFIX}/openclaw.base.json`, size: 1, sha256: "x", mode: 0o600 } }],
      }, cfg, () => { checks++; });
      assert.equal(checks, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, "openclaw.base.json"), "utf8")), incoming);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("admits the documented Node versions, not the retired Node 22/25 contract", () => {
    for (const version of ["24.16.0", "24.18.0", "26.1.0"]) assertSupportedNode(version);
    for (const version of ["22.19.0", "24.15.0", "25.9.0", "26.0.0", "bad"]) assert.throws(() => assertSupportedNode(version));
  });

  it("validates both renders with actual target CLI (opt-in installed 2026.9.5, no provider calls)", { skip: process.env.FLEETMIND_OPENCLAW_CONTRACT !== "1" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-real-contract-"));
    try {
      for (const render of [() => renderAgentOpenClawJson(fleet(undefined, true), "alpha"), () => renderHostOpenClawJson(fleet(undefined, true), "box")]) {
        const c = render() as any;
        assert.deepEqual(c.update, { channel: "extended-stable" });
        // Optional external plugins unavailable in a clean state are deliberately disabled.
        c.plugins.allow = ["openai", "anthropic", "webhooks"];
        delete c.plugins.entries.custom; delete c.plugins.entries.slack;
        delete c.channels; delete c.bindings;
        c.gateway.auth = { mode: "token", token: "fixture-only-gateway" };
        if (c.hooks) c.hooks.token = "fixture-only-hooks";
        const p = path.join(dir, "openclaw.json"); fs.writeFileSync(p, JSON.stringify(c));
        validateOpenClawCandidate(p);
      }
      for (const render of [() => renderAgentOpenClawJson(wrenCodexFleet(), "wren"), () => renderHostOpenClawJson(wrenCodexFleet(), "box")]) {
        const c = render() as any;
        assert.equal(c.agents.entries.wren.models["openai/*"].agentRuntime.id, "codex");
        c.plugins.allow = ["openai", "anthropic", "codex", "webhooks"];
        delete c.channels; delete c.bindings;
        c.gateway.auth = { mode: "token", token: "fixture-only-gateway" };
        if (c.hooks) c.hooks.token = "fixture-only-hooks";
        const p = path.join(dir, "openclaw-wren.json"); fs.writeFileSync(p, JSON.stringify(c));
        validateOpenClawCandidate(p);
      }
      const live = path.join(dir, "live.json"); fs.writeFileSync(live, "old-bytes\n");
      assert.throws(() => publishOpenClawConfig(live, { invalid: "fixture-secret-not-for-errors" }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("fixture-secret-not-for-errors"));
        return /validation failed/.test(error.message);
      });
      assert.equal(fs.readFileSync(live, "utf8"), "old-bytes\n");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
