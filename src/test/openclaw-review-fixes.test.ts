import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { FleetSchema } from "../config/schema.js";
import { loadFleet } from "../config/loader.js";
import { normalizeFleet } from "../core/model.js";
import { renderAgentFleetYaml, renderAgentOpenClawJson } from "../runtime/renderer.js";
import { mergeCanonicalConfigs, publishOpenClawConfig } from "../runtime/openclaw-config.js";
import { applyDiff, mergeOpenClawConfig, prepareOpenClawConfig, createPullStaging } from "../cli/commands/pull-self.js";
import { writeOpenClawConfig } from "../cli/commands/up.js";
import { CONFIG_STAGING_PREFIX } from "../cli/commands/push-fleet.js";

function makeFleet(count = 2) {
  return normalizeFleet(FleetSchema.parse({ fleet: { name: "review" },
    targets: { box: { provider: "local", os: "linux" } },
    agents: { defaults: { target: "box" }, list: [
      { id: "alpha", name: "Alpha", providers: ["anthropic"], orchestrator: true },
      ...(count > 1 ? [{ id: "beta", name: "Beta", providers: ["anthropic"] }] : []),
    ] } }));
}
function scratch(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-review-fixes-"));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const binding = (agentId: string, peer?: string) => ({ agentId, match: { channel: "slack", accountId: "work", ...(peer ? { peer: { kind: "channel", id: peer } } : {}) } });
const config = (name: string) => ({ agents: { entries: { alpha: { name } } } });
const configDiff = { added: [{ path: `${CONFIG_STAGING_PREFIX}/openclaw.json`, size: 1, sha256: "x", mode: 0o600 }], modified: [], deleted: [] };

describe("compatibility review fixes", () => {
  it("MF1: single/multi FleetMind slices round-trip schema and actual loader without changing OpenClaw identity", () => scratch((root) => {
    for (const count of [1, 2]) {
      const fleet = makeFleet(count);
      for (const agent of fleet.agents.list) {
        const text = renderAgentFleetYaml(fleet, agent.id);
        const parsed = parse(text);
        assert.equal(parsed.agents.self.id, agent.id);
        assert.equal(FleetSchema.safeParse(parsed).success, true);
        const file = path.join(root, `${count}-${agent.id}.yaml`); fs.writeFileSync(file, text);
        const loaded = loadFleet(file, { expandEnv: false });
        assert.deepEqual(loaded.agents.list.map((a) => a.id).sort(), fleet.agents.list.map((a) => a.id).sort());
        assert.equal(loaded.agents.list[0]!.id, agent.id);
        const oc = renderAgentOpenClawJson(fleet, agent.id) as any;
        assert.deepEqual(Object.keys(oc.agents.entries), [agent.id]);
        assert.equal(oc.agents.entries[agent.id].id, undefined);
      }
    }
  }));

  it("MF2: source replacement during production apply validation cannot replace the frozen baseline", () => scratch((root) => {
    const stage = path.join(root, "stage"), cfg = path.join(root, "cfg");
    fs.mkdirSync(path.join(stage, CONFIG_STAGING_PREFIX), { recursive: true }); fs.mkdirSync(cfg);
    const incoming = path.join(stage, CONFIG_STAGING_PREFIX, "openclaw.json");
    fs.writeFileSync(incoming, JSON.stringify(config("A")));
    const prepared = prepareOpenClawConfig(incoming, path.join(cfg, "openclaw.json"), cfg);
    assert.ok(Object.isFrozen(prepared.incoming.agents.entries.alpha));
    applyDiff(stage, path.join(root, "ws"), configDiff, cfg, () => {
      fs.unlinkSync(incoming); fs.writeFileSync(incoming, JSON.stringify(config("B")));
    });
    for (const name of ["openclaw.json", "openclaw.base.json"]) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, name), "utf8")), config("A"));
    }
  }));

  it("MF2: overlapping pull allocations cannot overwrite each other's archives or extraction roots", () => {
    const a = createPullStaging(), b = createPullStaging();
    try {
      assert.notEqual(a.root, b.root); assert.notEqual(a.tarballPath, b.tarballPath);
      fs.writeFileSync(a.tarballPath, "A"); fs.writeFileSync(b.tarballPath, "B");
      fs.writeFileSync(path.join(a.stagingDir, "sentinel"), "A");
      fs.rmSync(b.root, { recursive: true });
      assert.equal(fs.readFileSync(a.tarballPath, "utf8"), "A");
      assert.equal(fs.readFileSync(path.join(a.stagingDir, "sentinel"), "utf8"), "A");
    } finally { fs.rmSync(a.root, { recursive: true, force: true }); fs.rmSync(b.root, { recursive: true, force: true }); }
  });

  it("SF1: malformed incoming/live/base inputs never leak parser excerpts through production apply", () => scratch((root) => {
    const stage = path.join(root, "stage"), cfg = path.join(root, "cfg");
    fs.mkdirSync(path.join(stage, CONFIG_STAGING_PREFIX), { recursive: true }); fs.mkdirSync(cfg);
    const paths = { incoming: path.join(stage, CONFIG_STAGING_PREFIX, "openclaw.json"), live: path.join(cfg, "openclaw.json"), base: path.join(cfg, "openclaw.base.json") };
    for (const source of ["incoming", "live", "base"] as const) {
      for (const malformed of ['{"token":FAKE_REVIEW_SECRET}', 'FAKE_REVIEW_SECRET', 'null', '[]', '{"agents":{"list":"FAKE_REVIEW_SECRET"}}']) {
        for (const file of Object.values(paths)) fs.writeFileSync(file, JSON.stringify(config("A")));
        fs.writeFileSync(paths[source], malformed);
        const before = fs.readFileSync(paths.live), baseBefore = fs.readFileSync(paths.base);
        const check = (error: unknown) => {
          assert.ok(error instanceof Error); assert.match(error.message, new RegExp(`Cannot read ${source} OpenClaw config:`));
          assert.ok(!error.message.includes("FAKE_REVIEW_SECRET")); assert.ok(!error.stack?.includes("FAKE_REVIEW_SECRET")); return true;
        };
        assert.throws(() => mergeOpenClawConfig(paths.incoming, paths.live, cfg), check);
        assert.throws(() => applyDiff(stage, path.join(root, "ws"), configDiff, cfg, () => assert.fail("must not validate malformed input")), check);
        assert.deepEqual(fs.readFileSync(paths.live), before); assert.deepEqual(fs.readFileSync(paths.base), baseBefore);
      }
    }
  }));

  it("SF1: local-up publication redacts malformed live/base without publishing or validating", () => scratch((root) => {
    for (const source of ["live", "base"] as const) {
      const live = path.join(root, "openclaw.json"), base = path.join(root, "openclaw.base.json");
      fs.writeFileSync(live, JSON.stringify(config("A"))); fs.writeFileSync(base, JSON.stringify(config("A")));
      fs.writeFileSync(source === "live" ? live : base, '{"token":FAKE_REVIEW_SECRET}');
      const before = fs.readFileSync(live), oldBase = fs.readFileSync(base);
      assert.throws(() => writeOpenClawConfig(makeFleet(), "box", root, () => assert.fail("must not validate")), (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, new RegExp(`Cannot read ${source} OpenClaw config:`));
        assert.ok(!error.message.includes("FAKE_REVIEW_SECRET")); return true;
      });
      assert.deepEqual(fs.readFileSync(live), before); assert.deepEqual(fs.readFileSync(base), oldBase);
    }
  }));

  it("SF2: same-match retargeting/deletion fails rather than retaining a shadowed operator route", () => {
    const base = { bindings: [binding("a")] };
    for (const live of [{ bindings: [binding("b")] }, { bindings: [] }, {}]) {
      assert.throws(() => mergeCanonicalConfigs(base, live, base), /binding ownership conflict/);
    }
    assert.throws(() => mergeCanonicalConfigs(base, { bindings: [binding("b")] }), /binding ownership conflict/);
    // Property order and implicit default account cannot evade match identity.
    assert.throws(() => mergeCanonicalConfigs({ bindings: [{ agentId: "a", match: { channel: "slack" } }] },
      { bindings: [{ agentId: "b", match: { accountId: "default", channel: "slack" } }] }), /binding ownership conflict/);
    const reconciled = mergeCanonicalConfigs({ bindings: [binding("b")] }, { bindings: [binding("b")] }, base);
    assert.deepEqual(reconciled.bindings, [binding("b")]);
    assert.deepEqual(mergeCanonicalConfigs({ bindings: [] }, { bindings: [] }, base).bindings, []);
    assert.deepEqual(mergeCanonicalConfigs({ bindings: [] }, base, base).bindings, []);
  });

  it("SF2: production publication rejects retargeting/deletion with safe errors and unchanged files", () => scratch((root) => {
    const stage = path.join(root, "stage"), cfg = path.join(root, "cfg"), ws = path.join(root, "ws");
    fs.mkdirSync(path.join(stage, CONFIG_STAGING_PREFIX), { recursive: true }); fs.mkdirSync(cfg);
    const base = { bindings: [binding("a", "FAKE_ROUTE_SECRET")] };
    fs.writeFileSync(path.join(stage, CONFIG_STAGING_PREFIX, "openclaw.json"), JSON.stringify(base));
    for (const routes of [[binding("b", "FAKE_ROUTE_SECRET")], []]) {
      fs.writeFileSync(path.join(cfg, "openclaw.base.json"), JSON.stringify(base));
      fs.writeFileSync(path.join(cfg, "openclaw.json"), JSON.stringify({ bindings: routes }));
      const liveBefore = fs.readFileSync(path.join(cfg, "openclaw.json")), baseBefore = fs.readFileSync(path.join(cfg, "openclaw.base.json"));
      assert.throws(() => applyDiff(stage, ws, configDiff, cfg, () => assert.fail("conflict must not validate")), (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, /binding ownership conflict/);
        assert.ok(!error.stack?.includes("FAKE_ROUTE_SECRET")); return true;
      });
      assert.deepEqual(fs.readFileSync(path.join(cfg, "openclaw.json")), liveBefore);
      assert.deepEqual(fs.readFileSync(path.join(cfg, "openclaw.base.json")), baseBefore);
      assert.equal(fs.existsSync(ws), false);
    }
  }));

  it("SF2: target-normalized aliases and duplicate matches cannot silently shadow routing", () => {
    const pairs = [
      [{ channel: "Slack", accountId: " Work " }, { channel: "slack", accountId: "work" }],
      [{ channel: "slack", accountId: "" }, { channel: "slack", accountId: "default" }],
      [{ channel: "slack", peer: { kind: "group", id: " CROOM " } }, { channel: "slack", peer: { kind: "channel", id: "CROOM" } }],
      [{ channel: "discord", guildId: "G", roles: ["one", "two"] }, { channel: "discord", guildId: "G", roles: ["two", "one"] }],
    ];
    for (const [a, b] of pairs) {
      const incoming = { bindings: [{ agentId: "a", match: a }] }, live = { bindings: [{ agentId: "b", match: b }] };
      assert.throws(() => mergeCanonicalConfigs(incoming, live), /binding ownership conflict/);
      assert.throws(() => mergeCanonicalConfigs({ bindings: [...incoming.bindings, ...live.bindings] }, {}), /binding ownership conflict/);
    }
  });

  it("SF2: additional/narrower operator routes retain effective precedence and unmanaged deletions stay deleted", () => {
    const base = { bindings: [binding("a")] };
    const narrow = binding("b", "CROOM");
    const incoming = { bindings: [binding("c")] };
    const once = mergeCanonicalConfigs(incoming, { bindings: [narrow, ...base.bindings] }, base);
    // OpenClaw chooses the more specific peer tier before account routes.
    const resolved = once.bindings.find((r: any) => r.match.peer?.id === "CROOM") ?? once.bindings.find((r: any) => r.match.accountId === "work");
    assert.equal(resolved.agentId, "b");
    assert.equal(once.bindings.filter((r: any) => !r.match.peer)[0].agentId, "c");
    const twice = mergeCanonicalConfigs(incoming, once, incoming); assert.deepEqual(twice.bindings, once.bindings);
    assert.deepEqual(mergeCanonicalConfigs(incoming, incoming, incoming).bindings, incoming.bindings);
  });

  it("SF3: explicit model ownership does not erase colliding nested operator tools/denies or deletions", () => {
    const base = { agents: { entries: { a: { name: "A", workspace: "/old", model: { primary: "old", fallbacks: ["old-fallback"] }, tools: { profile: "coding", deny: ["browser"], allow: ["read"] } } } } };
    const live = structuredClone(base); live.agents.entries.a.tools.deny.push("exec"); delete (live.agents.entries.a.tools as any).allow;
    live.agents.entries.a.model.fallbacks = ["operator-fallback"];
    const incoming = structuredClone(base); incoming.agents.entries.a.tools.profile = "full"; incoming.agents.entries.a.workspace = "/new";
    incoming.agents.entries.a.model = { primary: "new", fallbacks: [] };
    const once = mergeCanonicalConfigs(incoming, live, base);
    assert.deepEqual(once.agents.entries.a.tools, { profile: "full", deny: ["browser", "exec"] });
    assert.equal(once.agents.entries.a.workspace, "/new"); assert.deepEqual(once.agents.entries.a.model, incoming.agents.entries.a.model);
    const twice = mergeCanonicalConfigs(incoming, once, incoming); assert.deepEqual(twice.agents.entries.a, once.agents.entries.a);
    scratch((root) => {
      const stage = path.join(root, "stage"), cfg = path.join(root, "cfg");
      fs.mkdirSync(path.join(stage, CONFIG_STAGING_PREFIX), { recursive: true }); fs.mkdirSync(cfg);
      fs.writeFileSync(path.join(stage, CONFIG_STAGING_PREFIX, "openclaw.json"), JSON.stringify(incoming));
      fs.writeFileSync(path.join(cfg, "openclaw.json"), JSON.stringify(live));
      fs.writeFileSync(path.join(cfg, "openclaw.base.json"), JSON.stringify(base));
      let validated = false;
      applyDiff(stage, path.join(root, "ws"), configDiff, cfg, (candidate) => {
        assert.deepEqual(JSON.parse(fs.readFileSync(candidate, "utf8")).agents.entries.a.tools, once.agents.entries.a.tools);
        validated = true;
      });
      assert.ok(validated);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, "openclaw.json"), "utf8")).agents.entries.a, once.agents.entries.a);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, "openclaw.base.json"), "utf8")), incoming);
    });
  });

  it("candidate contents, inode, symlink and permissions cannot change during validation and publish", () => scratch((root) => {
    const dest = path.join(root, "live.json"); fs.writeFileSync(dest, "old-live-bytes");
    for (const mutate of [
      (p: string) => fs.writeFileSync(p, '{"injected":true}'),
      (p: string) => { const same = fs.readFileSync(p); const other = `${p}.other`; fs.writeFileSync(other, same, { mode: 0o600 }); fs.renameSync(other, p); },
      (p: string) => { fs.unlinkSync(p); fs.symlinkSync(dest, p); },
      (p: string) => fs.chmodSync(p, 0o644),
    ]) {
      assert.throws(() => publishOpenClawConfig(dest, config("A"), mutate), /candidate changed during validation/);
      assert.equal(fs.readFileSync(dest, "utf8"), "old-live-bytes");
      assert.deepEqual(fs.readdirSync(root), ["live.json"]);
    }
  }));
});
