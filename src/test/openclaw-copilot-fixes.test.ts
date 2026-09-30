import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { normalizeOpenClawConfig } from "../runtime/openclaw-config.js";
import { applyDiff } from "../cli/commands/pull-self.js";
import { writeOpenClawConfig } from "../cli/commands/up.js";
import { CONFIG_STAGING_PREFIX } from "../cli/commands/push-fleet.js";

const fleet = () => normalizeFleet(FleetSchema.parse({ fleet: { name: "copilot" },
  targets: { box: { provider: "local", os: "linux" } },
  agents: { defaults: { target: "box" }, list: [{ id: "alpha", name: "Alpha", providers: ["anthropic"] }] },
}));
const config = { agents: { entries: { alpha: { name: "Before" } } } };
const bytes = JSON.stringify(config);

// Inject only the timing of an actual filesystem edit. Both real callers still
// read/parse/merge/stage/publish through the production implementation.
for (const caller of ["pull", "up"] as const) {
  for (const phase of ["before", "during"] as const) {
    for (const change of ["modify", "create", "delete"] as const) {
      test(`${caller} preserves a live ${change} ${phase} validation and never advances baseline/workspace`, (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-copilot-race-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const cfg = path.join(root, "cfg"), stage = path.join(root, "stage"), ws = path.join(root, "ws");
        fs.mkdirSync(cfg); fs.mkdirSync(path.join(stage, CONFIG_STAGING_PREFIX), { recursive: true });
        const live = path.join(cfg, "openclaw.json"), base = path.join(cfg, "openclaw.base.json");
        fs.writeFileSync(base, bytes);
        if (change !== "create") fs.writeFileSync(live, bytes);
        fs.writeFileSync(path.join(stage, CONFIG_STAGING_PREFIX, "openclaw.json"), bytes);
        fs.writeFileSync(path.join(stage, "SOUL.md"), "must not publish");
        const diff = { added: [`${CONFIG_STAGING_PREFIX}/openclaw.json`, "SOUL.md"].map((p) =>
          ({ path: p, size: 1, mode: 0o600, sha256: "fixture" })), modified: [], deleted: [] };
        let changed = false, validations = 0;
        const edit = () => {
          changed = true;
          if (change === "delete") fs.unlinkSync(live);
          else fs.writeFileSync(live, '{ "operator": "FAKE_PRIVATE_VALUE" }\n');
        };
        const read = fs.readFileSync;
        // The baseline is read after the live snapshot, before publication.
        const hook = t.mock.method(fs, "readFileSync", ((...args: any[]) => {
          const result = (read as any)(...args);
          if (phase === "before" && args[0] === base && !changed) edit();
          return result;
        }) as typeof fs.readFileSync);
        const validate = () => { validations++; if (phase === "during") edit(); };
        try {
          assert.throws(() => caller === "pull" ? applyDiff(stage, ws, diff, cfg, validate)
            : writeOpenClawConfig(fleet(), "box", cfg, validate), (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.match(error.message, new RegExp(`Config changed ${phase} validation`));
              assert.ok(!error.stack?.includes("FAKE_PRIVATE_VALUE"));
              return true;
            });
        } finally { hook.mock.restore(); }
        assert.ok(changed);
        assert.equal(validations, phase === "before" ? 0 : 1);
        assert.equal(fs.existsSync(live), change !== "delete");
        if (change !== "delete") assert.equal(fs.readFileSync(live, "utf8"), '{ "operator": "FAKE_PRIVATE_VALUE" }\n');
        assert.equal(fs.readFileSync(base, "utf8"), bytes);
        assert.equal(fs.existsSync(ws), false);
        assert.ok(!fs.readdirSync(cfg).some((p) => p.startsWith(".fleetmind-config-")));
      });
    }
  }
}

test("dual rosters ignore object order recursively but reject changed values and reordered arrays", () => {
  const legacy = [
    { id: "alpha", name: "Alpha", tools: { deny: ["exec", "browser"], profile: "coding" } },
    { id: "beta", name: "Beta", model: { primary: "anthropic/example", fallbacks: ["one", "two"] } },
  ];
  const canonical = {
    beta: { model: { fallbacks: ["one", "two"], primary: "anthropic/example" }, name: "Beta" },
    alpha: { tools: { profile: "coding", deny: ["exec", "browser"] }, name: "Alpha" },
  };
  const normalized = normalizeOpenClawConfig({ agents: { list: legacy, entries: canonical } });
  assert.deepEqual(normalized.agents.entries, canonical);
  assert.equal(normalized.agents.list, undefined);
  assert.deepEqual(normalizeOpenClawConfig(normalized), normalized);
  for (const mutate of [
    (c: typeof canonical) => { c.alpha.name = "Other"; },
    (c: typeof canonical) => { c.alpha.tools.deny.reverse(); },
    (c: typeof canonical) => { c.beta.model.fallbacks.reverse(); },
  ]) {
    const changed = structuredClone(canonical); mutate(changed);
    assert.throws(() => normalizeOpenClawConfig({ agents: { list: legacy, entries: changed } }), /Conflicting legacy and canonical/);
  }
});

for (const mode of ["daemon", "no-daemon", "dry-run"] as const) {
  test(`actual up CLI ${mode} without OpenClaw gives actionable preflight and writes no state`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-copilot-cli-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, "home"); fs.mkdirSync(home);
    const fleetFile = path.join(root, "fleet.yaml");
    fs.writeFileSync(fleetFile, `fleet:\n  name: preflight\ntargets:\n  box:\n    provider: local\n    os: linux\nagents:\n  defaults:\n    target: box\n  list:\n    - id: alpha\n      name: Alpha\n      providers: [anthropic]\n      skills: []\n`);
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const cli = fileURLToPath(new URL(`../cli/index.${ext}`, import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", cli, "up", fleetFile,
      ...(mode === "no-daemon" ? ["--no-daemon"] : mode === "dry-run" ? ["--dry-run"] : [])], {
      env: { PATH: "", HOME: home, NO_COLOR: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    const output = result.stdout + result.stderr;
    if (mode === "dry-run") {
      assert.equal(result.status, 0, output);
      assert.doesNotMatch(output, /not found on PATH/);
    } else {
      assert.equal(result.status, 1, output);
      assert.match(output, /`openclaw` not found on PATH/);
      assert.match(output, /npm install -g openclaw@2026\.9\.5/);
      assert.doesNotMatch(output, /candidate validation failed/);
    }
    assert.deepEqual(fs.readdirSync(home), []);
  });
}
