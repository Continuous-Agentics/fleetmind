/**
 * Unit tests for `fleetmind secrets populate`.
 *
 * Covers:
 *   - Env var resolution from agent slack placeholders
 *   - Correct secret name construction (${fleet_name}/agents/${agent_id}/...)
 *   - Error when required env var is missing
 *   - Dry-run does NOT call AWS PutSecretValueCommand
 *   - --agent filter works
 *   - --from env file is loaded correctly
 *   - Anthropic key resolution (per-agent → field → fleet-wide fallback)
 *   - signing_secret is optional (not needed for socket-mode)
 *   - populate does NOT prompt for SLACK_SIGNING_SECRET
 *   - fleet.yaml without signing_secret parses cleanly
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  extractPlaceholder,
  resolveValue,
  resolveSlack,
  resolveProviderKey,
  materializeHostEnv,
  generateHooksToken,
  loadEnvFile,
  redact,
  populateSecrets,
  type PopulateOptions,
} from "../cli/commands/populate.js";
import { normalizeFleet } from "../core/model.js";
import { FleetSchema } from "../config/schema.js";

// ── extractPlaceholder ────────────────────────────────────────────────────────

describe("extractPlaceholder", () => {
  test("extracts var name from ${VAR} placeholder", () => {
    assert.equal(extractPlaceholder("${CONDUCTOR_BOT_TOKEN}"), "CONDUCTOR_BOT_TOKEN");
  });

  test("returns null for literal value", () => {
    assert.equal(extractPlaceholder("xoxb-literal-token"), null);
  });

  test("returns null for undefined", () => {
    assert.equal(extractPlaceholder(undefined), null);
  });

  test("returns null for partial placeholder", () => {
    assert.equal(extractPlaceholder("prefix-${VAR}"), null);
  });
});

// ── resolveValue ──────────────────────────────────────────────────────────────

describe("resolveValue", () => {
  test("resolves placeholder from env", () => {
    assert.equal(resolveValue("${MY_TOKEN}", { MY_TOKEN: "xoxb-123" }), "xoxb-123");
  });

  test("returns literal value unchanged", () => {
    assert.equal(resolveValue("literal-value", {}), "literal-value");
  });

  test("returns null when placeholder not in env", () => {
    assert.equal(resolveValue("${MISSING}", {}), null);
  });

  test("returns null for undefined input", () => {
    assert.equal(resolveValue(undefined, {}), null);
  });
});

// ── resolveSlack ──────────────────────────────────────────────────────────────

describe("resolveSlack", () => {
  const env = {
    CONDUCTOR_BOT_TOKEN: "xoxb-bot",
    CONDUCTOR_APP_TOKEN: "xapp-app",
  };

  const slack = {
    account_id: "conductor",
    bot_token: "${CONDUCTOR_BOT_TOKEN}",
    app_token: "${CONDUCTOR_APP_TOKEN}",
  };

  test("resolves all Slack fields when env vars are set", () => {
    const res = resolveSlack("conductor", slack, env);
    assert.equal(res.ok, true);
    assert.equal(res.values.SLACK_BOT_TOKEN, "xoxb-bot");
    assert.equal(res.values.SLACK_APP_TOKEN, "xapp-app");
    assert.deepEqual(res.missing, []);
  });

  test("reports missing env vars when not set", () => {
    const res = resolveSlack("conductor", slack, {});
    assert.equal(res.ok, false);
    assert.ok(res.missing.includes("CONDUCTOR_BOT_TOKEN"));
    assert.ok(res.missing.includes("CONDUCTOR_APP_TOKEN"));
  });

  test("partial resolution — only missing vars reported", () => {
    const partialEnv = { CONDUCTOR_BOT_TOKEN: "xoxb-bot" };
    const res = resolveSlack("conductor", slack, partialEnv);
    assert.equal(res.ok, false);
    assert.equal(res.missing.length, 1);
    assert.ok(res.missing.includes("CONDUCTOR_APP_TOKEN"));
  });

  test("handles literal values (not placeholders)", () => {
    const literalSlack = {
      account_id: "test",
      bot_token: "xoxb-literal",
      app_token: "xapp-literal",
    };
    const res = resolveSlack("test", literalSlack, {});
    assert.equal(res.ok, true);
    assert.equal(res.values.SLACK_BOT_TOKEN, "xoxb-literal");
  });

  test("does not resolve SLACK_SIGNING_SECRET (not needed for socket-mode)", () => {
    const envWithSecret = { ...env, CONDUCTOR_SIGNING_SECRET: "should-be-ignored" };
    const res = resolveSlack("conductor", slack, envWithSecret);
    assert.equal(res.ok, true);
    assert.equal((res.values as Record<string, unknown>)["SLACK_SIGNING_SECRET"], undefined,
      "SLACK_SIGNING_SECRET must not appear in resolved values");
  });
});

// ── resolveProviderKey ────────────────────────────────────────────────────────

describe("resolveProviderKey", () => {
  test("per-agent env var takes precedence", () => {
    const env = {
      CONDUCTOR_ANTHROPIC_API_KEY: "sk-ant-per-agent",
      ANTHROPIC_API_KEY: "sk-ant-fleet-wide",
    };
    const res = resolveProviderKey("conductor", "anthropic", undefined, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-per-agent");
  });

  test("falls back to fleet-wide <PROVIDER>_API_KEY", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-fleet-wide" };
    const res = resolveProviderKey("conductor", "anthropic", undefined, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-fleet-wide");
  });

  test("resolves the api_keys[provider] placeholder", () => {
    const env = { MY_CUSTOM_ANTHROPIC_KEY: "sk-ant-custom" };
    const res = resolveProviderKey("conductor", "anthropic", { anthropic: "${MY_CUSTOM_ANTHROPIC_KEY}" }, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-custom");
  });

  test("returns missing (per-agent var) when no key found", () => {
    const res = resolveProviderKey("conductor", "anthropic", undefined, {});
    assert.equal(res.ok, false);
    assert.ok(res.missing.includes("CONDUCTOR_ANTHROPIC_API_KEY"));
  });

  test("per-agent var name is <AGENT>_<PROVIDER>_API_KEY", () => {
    const env = { FORGE_ANTHROPIC_API_KEY: "sk-ant-forge" };
    const res = resolveProviderKey("forge", "anthropic", undefined, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-forge");
  });

  test("generalizes to non-anthropic providers (openai)", () => {
    // per-agent override
    assert.equal(
      resolveProviderKey("conductor", "openai", undefined, { CONDUCTOR_OPENAI_API_KEY: "sk-oai-agent" }).value,
      "sk-oai-agent"
    );
    // fleet-wide fallback
    assert.equal(
      resolveProviderKey("conductor", "openai", undefined, { OPENAI_API_KEY: "sk-oai-fleet" }).value,
      "sk-oai-fleet"
    );
    // missing reports the openai-shaped per-agent var
    assert.ok(
      resolveProviderKey("conductor", "openai", undefined, {}).missing.includes("CONDUCTOR_OPENAI_API_KEY")
    );
  });
});

// ── loadEnvFile ───────────────────────────────────────────────────────────────

describe("loadEnvFile", () => {
  let tmpDir: string;
  let envFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-test-"));
    envFile = path.join(tmpDir, ".env.fleet");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses key=value pairs", () => {
    fs.writeFileSync(envFile, "FOO=bar\nBAZ=qux\n");
    const result = loadEnvFile(envFile);
    assert.equal(result["FOO"], "bar");
    assert.equal(result["BAZ"], "qux");
  });

  test("strips surrounding quotes", () => {
    fs.writeFileSync(envFile, 'KEY="quoted value"\nKEY2=\'single\'\n');
    const result = loadEnvFile(envFile);
    assert.equal(result["KEY"], "quoted value");
    assert.equal(result["KEY2"], "single");
  });

  test("ignores comment lines", () => {
    fs.writeFileSync(envFile, "# comment\nFOO=bar\n");
    const result = loadEnvFile(envFile);
    assert.ok(!result["# comment"]);
    assert.equal(result["FOO"], "bar");
  });

  test("ignores blank lines", () => {
    fs.writeFileSync(envFile, "\nFOO=bar\n\n");
    const result = loadEnvFile(envFile);
    assert.equal(Object.keys(result).length, 1);
  });

  test("throws when file does not exist", () => {
    assert.throws(() => loadEnvFile("/nonexistent/.env"), /not found/);
  });
});

// ── redact ────────────────────────────────────────────────────────────────────

describe("redact", () => {
  test("redacts long token showing first 8 and last 4 chars", () => {
    const r = redact("xoxb-12345678901234");
    assert.match(r, /^xoxb-123/);
    assert.match(r, /1234$/);
    assert.ok(r.includes("..."));
  });

  test("returns *** for short tokens", () => {
    assert.equal(redact("short"), "***");
  });
});
// ── generateHooksToken ────────────────────────────────────────────────────────

describe("generateHooksToken", () => {
  test("returns a 64-character hex string", () => {
    const token = generateHooksToken();
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  test("returns a different value on each call", () => {
    const a = generateHooksToken();
    const b = generateHooksToken();
    assert.notEqual(a, b, "tokens should be unique");
  });
});


// ── populateSecrets — dry-run ─────────────────────────────────────────────────

describe("populateSecrets dry-run", () => {
  let tmpDir: string;
  let fleetFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-fleet-"));
    fleetFile = path.join(tmpDir, "fleet.yaml");

    // Write a minimal fleet.yaml (no signing_secret — not needed for socket-mode)
    fs.writeFileSync(fleetFile, `
fleet:
  name: test-fleet
delegation:
  enabled: false
  aws_region: us-west-2
agents:
  defaults:
    model: anthropic/claude-haiku-4
  list:
    - id: conductor
      name: Conductor
      providers: [anthropic]
      channels:
        - provider: slack
          account_id: conductor
          bot_token: "\${CONDUCTOR_BOT_TOKEN}"
          app_token: "\${CONDUCTOR_APP_TOKEN}"
    - id: forge
      name: Forge
      providers: [anthropic]
      channels:
        - provider: slack
          account_id: forge
          bot_token: "\${FORGE_BOT_TOKEN}"
          app_token: "\${FORGE_APP_TOKEN}"
`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("dry-run returns 6 results without calling AWS", async () => {
    const opts: PopulateOptions = {
      fleet: fleetFile,
      dryRun: true,
      agent: [],
    };

    // Set all required env vars
    const savedEnv: Record<string, string | undefined> = {};
    const vars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN",
      "FORGE_BOT_TOKEN", "FORGE_APP_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    for (const v of vars) {
      savedEnv[v] = process.env[v];
      process.env[v] = `test-${v.toLowerCase()}`;
    }

    try {
      const results = await populateSecrets(opts);

      // 6 results: conductor/slack, conductor/providers/anthropic, conductor/hooks,
      //            forge/slack, forge/providers/anthropic, forge/hooks
      assert.equal(results.length, 6);

      const names = results.map((r) => r.secretName);
      assert.ok(names.includes("test-fleet/agents/conductor/slack"));
      assert.ok(names.includes("test-fleet/agents/conductor/providers/anthropic"));
      assert.ok(names.includes("test-fleet/agents/conductor/hooks"));
      assert.ok(names.includes("test-fleet/agents/forge/slack"));
      assert.ok(names.includes("test-fleet/agents/forge/providers/anthropic"));
      assert.ok(names.includes("test-fleet/agents/forge/hooks"));

      // All dry-run — pushed=false
      for (const r of results) {
        assert.equal(r.ok, true);
        assert.equal(r.pushed, false);
      }
    } finally {
      for (const v of vars) {
        if (savedEnv[v] === undefined) delete process.env[v];
        else process.env[v] = savedEnv[v];
      }
    }
  });

  test("constructs correct secret name with fleet_name prefix", async () => {
    const savedEnv: Record<string, string | undefined> = {};
    const vars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "ANTHROPIC_API_KEY"];
    for (const v of vars) {
      savedEnv[v] = process.env[v];
      process.env[v] = `val-${v}`;
    }

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],
      });

      assert.equal(results.length, 3);
      assert.equal(results[0]!.secretName, "test-fleet/agents/conductor/slack");
      assert.equal(results[1]!.secretName, "test-fleet/agents/conductor/providers/anthropic");
      assert.equal(results[2]!.secretName, "test-fleet/agents/conductor/hooks");
    } finally {
      for (const v of vars) {
        if (savedEnv[v] === undefined) delete process.env[v];
        else process.env[v] = savedEnv[v];
      }
    }
  });

  test("fleet.yaml with signing_secret still parses (backward compat — field is optional/ignored)", async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fm-compat-"));
    const legacyFleet = path.join(tmpDir2, "fleet.yaml");
    fs.writeFileSync(legacyFleet, `
fleet:
  name: legacy-fleet
delegation:
  enabled: false
  aws_region: us-west-2
agents:
  defaults:
    model: anthropic/claude-haiku-4
  list:
    - id: conductor
      name: Conductor
      providers: [anthropic]
      channels:
        - provider: slack
          account_id: conductor
          bot_token: "\${CONDUCTOR_BOT_TOKEN}"
          app_token: "\${CONDUCTOR_APP_TOKEN}"
          signing_secret: "\${CONDUCTOR_SIGNING_SECRET}"
`);

    const savedEnv: Record<string, string | undefined> = {};
    const vars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "CONDUCTOR_SIGNING_SECRET", "ANTHROPIC_API_KEY"];
    for (const v of vars) { savedEnv[v] = process.env[v]; process.env[v] = `val-${v}`; }

    try {
      // Should NOT throw — signing_secret is accepted but ignored
      const results = await populateSecrets({ fleet: legacyFleet, dryRun: true, agent: ["conductor"] });
      assert.equal(results.length, 3, "conductor produces 3 results even with signing_secret present in yaml");
      assert.ok(results.every((r) => r.ok));
    } finally {
      for (const v of vars) {
        if (savedEnv[v] === undefined) delete process.env[v]; else process.env[v] = savedEnv[v];
      }
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  test("errors when required env var is missing", async () => {
    // Ensure CONDUCTOR_BOT_TOKEN is NOT set
    const saved = process.env["CONDUCTOR_BOT_TOKEN"];
    delete process.env["CONDUCTOR_BOT_TOKEN"];

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],
      });

      const slackResult = results.find((r) => r.secretType === "slack");
      assert.ok(slackResult);
      assert.equal(slackResult.ok, false);
      assert.ok(slackResult.missing?.includes("CONDUCTOR_BOT_TOKEN"));
    } finally {
      if (saved !== undefined) process.env["CONDUCTOR_BOT_TOKEN"] = saved;
    }
  });

  test("--agent filter restricts to specified agents", async () => {
    const savedEnv: Record<string, string | undefined> = {};
    const vars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "ANTHROPIC_API_KEY"];
    for (const v of vars) {
      savedEnv[v] = process.env[v];
      process.env[v] = `val-${v}`;
    }

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],
      });

      // Only conductor — no forge results
      assert.equal(results.length, 3);
      assert.ok(results.every((r) => r.agentId === "conductor"));
    } finally {
      for (const v of vars) {
        if (savedEnv[v] === undefined) delete process.env[v];
        else process.env[v] = savedEnv[v];
      }
    }
  });

  test("--from file loads env vars for resolution", async () => {
    const envFile = path.join(tmpDir, ".env.test");
    fs.writeFileSync(envFile, [
      "CONDUCTOR_BOT_TOKEN=xoxb-from-file",
      "CONDUCTOR_APP_TOKEN=xapp-from-file",
      "ANTHROPIC_API_KEY=sk-ant-from-file",
    ].join("\n"));

    // Make sure these are NOT in process.env
    const savedVars: Record<string, string | undefined> = {};
    for (const v of ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "ANTHROPIC_API_KEY"]) {
      savedVars[v] = process.env[v];
      delete process.env[v];
    }

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        from: envFile,
        agent: ["conductor"],
      });

      const slackRes = results.find((r) => r.secretType === "slack");
      assert.ok(slackRes);
      assert.equal(slackRes.ok, true, "slack should resolve from env file");

      const modelRes = results.find((r) => r.secretType === "provider:anthropic");
      assert.ok(modelRes);
      assert.equal(modelRes.ok, true, "anthropic key should resolve from env file");
    } finally {
      for (const [k, v] of Object.entries(savedVars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("combines every provider key into one /model secret (openai model + google api_key)", async () => {
    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "fm-openai-"));
    const openaiFleet = path.join(tmpDir3, "fleet.yaml");
    // pixel overrides to openai and also lists an explicit google api_key →
    // both land in ONE /model secret (no /anthropic, no per-provider secrets).
    fs.writeFileSync(openaiFleet, `
fleet:
  name: multi-fleet
delegation:
  enabled: false
  aws_region: us-west-2
agents:
  defaults:
    model: anthropic/claude-sonnet-4-6
  list:
    - id: pixel
      name: Pixel
      model: openai/gpt-4o
      providers: [openai, google]
      api_keys:
        google: "\${GOOGLE_API_KEY}"
      channels:
        - provider: slack
          account_id: pixel
          bot_token: "\${PIXEL_BOT_TOKEN}"
          app_token: "\${PIXEL_APP_TOKEN}"
`);

    const vars = ["PIXEL_BOT_TOKEN", "PIXEL_APP_TOKEN", "OPENAI_API_KEY", "GOOGLE_API_KEY"];
    const savedVars: Record<string, string | undefined> = {};
    for (const v of vars) { savedVars[v] = process.env[v]; process.env[v] = `val-${v}`; }

    try {
      const results = await populateSecrets({ fleet: openaiFleet, dryRun: true, agent: [] });
      const names = new Set(results.map((r) => r.secretName));
      // Per-provider fan-out: one secret per (agent, provider).
      assert.ok(names.has("multi-fleet/agents/pixel/providers/openai"), "should write /providers/openai");
      assert.ok(names.has("multi-fleet/agents/pixel/providers/google"), "should write /providers/google");
      assert.ok(!names.has("multi-fleet/agents/pixel/model"), "no combined /model");
      assert.ok(!names.has("multi-fleet/agents/pixel/providers/anthropic"), "no /providers/anthropic");
      assert.ok(results.every((r) => r.ok), "all should resolve from env");
    } finally {
      for (const v of vars) {
        if (savedVars[v] === undefined) delete process.env[v];
        else process.env[v] = savedVars[v];
      }
      fs.rmSync(tmpDir3, { recursive: true, force: true });
    }
  });
});

// ── Interactive mode ──────────────────────────────────────────────────────────

describe("populateSecrets --interactive", () => {
  let tmpDir: string;
  let fleetFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-interactive-"));
    fleetFile = path.join(tmpDir, "fleet.yaml");

    fs.writeFileSync(fleetFile, `
fleet:
  name: test-fleet
delegation:
  enabled: false
  aws_region: us-west-2
agents:
  defaults:
    model: anthropic/claude-haiku-4
  list:
    - id: conductor
      name: Conductor
      providers: [anthropic]
      channels:
        - provider: slack
          account_id: conductor
          bot_token: "\${CONDUCTOR_BOT_TOKEN}"
          app_token: "\${CONDUCTOR_APP_TOKEN}"
    - id: forge
      name: Forge
      providers: [anthropic]
      channels:
        - provider: slack
          account_id: forge
          bot_token: "\${FORGE_BOT_TOKEN}"
          app_token: "\${FORGE_APP_TOKEN}"
`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a simple promptFn stub that returns values in order from the queue. */
  function makePromptStub(responses: string[]): (prompt: string) => Promise<string> {
    const queue = [...responses];
    return async (_prompt: string) => queue.shift() ?? "";
  }

  /** Build a confirmFn stub that always returns the given answer. */
  function makeConfirmStub(answer: boolean): (prompt: string) => Promise<boolean> {
    return async (_prompt: string) => answer;
  }

  /** Helpers to clear / restore env vars. */
  function clearVars(vars: string[]): Record<string, string | undefined> {
    const saved: Record<string, string | undefined> = {};
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    return saved;
  }

  function restoreVars(saved: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // ── Test 1: env-set credentials are used silently (no prompt) ────────────────
  test("skips prompt for credentials already in env", async () => {
    const allVars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN",
      "FORGE_BOT_TOKEN", "FORGE_APP_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    const saved = clearVars(allVars);
    // Pre-set all env vars
    for (const v of allVars) process.env[v] = `val-${v.toLowerCase()}`;

    const promptCalls: string[] = [];
    const promptFn = async (p: string) => { promptCalls.push(p); return "should-not-be-called"; };

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: [],
        interactive: true,
        promptFn,
        confirmFn: makeConfirmStub(true),
      });

      // No prompts should have been triggered — everything was in env
      assert.equal(promptCalls.length, 0, "promptFn should not have been called when all env vars are set");
      assert.equal(results.length, 6, "should have 6 results");
      assert.ok(results.every((r) => r.ok));
    } finally {
      restoreVars(saved);
    }
  });

  // ── Test 2: prompts fired for missing credentials ─────────────────────────────
  test("prompts for missing credentials and uses supplied input", async () => {
    const allVars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    const saved = clearVars(allVars);

    // Provide answers for the 3 missing conductor fields (2 slack + 1 anthropic)
    const promptFn = makePromptStub([
      "xoxb-conductor-bot",
      "xapp-conductor-app",
      "sk-ant-conductor",
    ]);

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],
        interactive: true,
        promptFn,
        confirmFn: makeConfirmStub(true),
      });

      assert.equal(results.length, 3, "conductor should produce 3 results");
      assert.ok(results.every((r) => r.ok), "all results should be ok");
      // SLACK_SIGNING_SECRET must not appear in the pushed secret payload
      // (verified indirectly: only 3 prompts fired, none for signing_secret)
    } finally {
      restoreVars(saved);
    }
  });

  // ── Test 3: empty input re-prompts ────────────────────────────────────────────
  test("re-prompts on empty input until a value is supplied", async () => {
    const allVars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    const saved = clearVars(allVars);

    // First answer for bot_token is empty, second is real value
    const promptFn = makePromptStub([
      "",                       // empty → should re-prompt
      "xoxb-real-bot-token",   // real value
      "xapp-app",
      "sk-ant-key",
    ]);

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],
        interactive: true,
        promptFn,
        confirmFn: makeConfirmStub(true),
      });

      assert.equal(results.length, 3, "should produce 3 results after re-prompt");
      assert.ok(results.every((r) => r.ok));
    } finally {
      restoreVars(saved);
    }
  });

  // ── Test 4: confirmation summary lists all agent×secret ──────────────────────
  test("confirmation summary lists every agent/secret combination", async () => {
    const allVars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN",
      "FORGE_BOT_TOKEN", "FORGE_APP_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    const saved = clearVars(allVars);
    for (const v of allVars) process.env[v] = `val-${v.toLowerCase()}`;

    const summaryLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => summaryLines.push(args.join(" "));

    try {
      await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: [],
        interactive: true,
        promptFn: makePromptStub([]),
        confirmFn: makeConfirmStub(true),
      });
    } finally {
      console.log = origLog;
      restoreVars(saved);
    }

    const combined = summaryLines.join("\n");
    assert.ok(combined.includes("conductor/slack"), "summary should mention conductor/slack");
    assert.ok(combined.includes("conductor/provider:anthropic"), "summary should mention conductor/provider:anthropic");
    assert.ok(combined.includes("conductor/hooks"), "summary should mention conductor/hooks");
    assert.ok(combined.includes("forge/slack"), "summary should mention forge/slack");
    assert.ok(combined.includes("forge/provider:anthropic"), "summary should mention forge/provider:anthropic");
    assert.ok(combined.includes("forge/hooks"), "summary should mention forge/hooks");
    assert.ok(combined.includes("6 secrets"), "summary should state total secret count");
  });

  // ── Test 5: --interactive + --dry-run runs prompts but skips AWS ──────────────
  test("--interactive --dry-run runs prompts, shows summary, skips AWS", async () => {
    const allVars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    const saved = clearVars(allVars);

    const promptFn = makePromptStub([
      "xoxb-bot", "xapp-app", "sk-ant-key",
    ]);

    let confirmCalled = false;
    const confirmFn = async (_p: string) => { confirmCalled = true; return true; };

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,        // dry-run — no AWS
        agent: ["conductor"],
        interactive: true,
        promptFn,
        confirmFn,
      });

      // Prompts ran
      assert.equal(results.length, 3, "should have 3 dry-run results");
      assert.ok(results.every((r) => r.pushed === false), "dry-run: pushed should be false");

      // Confirm NOT called in dry-run (summary shown but no y/N)
      assert.equal(confirmCalled, false, "confirmFn should not be called for dry-run");
    } finally {
      restoreVars(saved);
    }
  });

  // ── Test 6: --agent filter skips other agents' prompts ───────────────────────
  test("--agent filter: only prompts for the specified agent", async () => {
    const allVars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN",
      "FORGE_BOT_TOKEN", "FORGE_APP_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    const saved = clearVars(allVars);

    const promptedFor: string[] = [];
    const answers = ["xoxb-bot", "xapp-app", "sk-ant-key"];
    const promptFn = async (p: string) => {
      promptedFor.push(p);
      return answers.shift() ?? "";
    };

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],  // only conductor
        interactive: true,
        promptFn,
        confirmFn: makeConfirmStub(true),
      });

      // Only conductor results
      assert.equal(results.length, 3, "only conductor results");
      assert.ok(results.every((r) => r.agentId === "conductor"));

      // No forge prompts
      assert.ok(
        promptedFor.every((p) => !p.toLowerCase().includes("forge")),
        "should not have prompted for forge credentials"
      );
    } finally {
      restoreVars(saved);
    }
  });

  // ── Test 7: confirmation "y" proceeds to push (dry-run verifies) ──────────────
  test("confirmation 'y' proceeds; 'n' aborts", async () => {
    const allVars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "ANTHROPIC_API_KEY"];
    const saved = clearVars(allVars);
    for (const v of allVars) process.env[v] = `val-${v.toLowerCase()}`;

    try {
      // "y" → results returned
      const yesResults = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],
        interactive: true,
        promptFn: makePromptStub([]),
        confirmFn: makeConfirmStub(true),
      });
      assert.equal(yesResults.length, 3, "'y' should return results");

      // "n" → empty results (aborted)
      // Note: dry-run skips confirmation, so test non-dry-run with mocked confirm
      // We can't actually call AWS in tests, so we verify the abort path returns []
      // by using a non-dry-run with confirmFn returning false.
      // AWS call would fail here — but abort happens before the AWS call.
      const noResults = await populateSecrets({
        fleet: fleetFile,
        dryRun: false,
        agent: ["conductor"],
        interactive: true,
        promptFn: makePromptStub([]),
        confirmFn: makeConfirmStub(false),  // "n" → abort
      });
      assert.equal(noResults.length, 0, "'n' should abort and return empty array");
    } finally {
      restoreVars(saved);
    }
  });

  // ── Test 8: --from env file provides values silently (no prompt) ──────────────
  test("--from env file provides credentials silently without prompting", async () => {
    const envFile = path.join(tmpDir, ".env.conductor");
    fs.writeFileSync(envFile, [
      "CONDUCTOR_BOT_TOKEN=xoxb-from-file",
      "CONDUCTOR_APP_TOKEN=xapp-from-file",
      "ANTHROPIC_API_KEY=sk-ant-from-file",
    ].join("\n"));

    const allVars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "ANTHROPIC_API_KEY"];
    const saved = clearVars(allVars);

    const promptCalls: string[] = [];
    const promptFn = async (p: string) => { promptCalls.push(p); return "unexpected-call"; };

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        from: envFile,
        agent: ["conductor"],
        interactive: true,
        promptFn,
        confirmFn: makeConfirmStub(true),
      });

      assert.equal(promptCalls.length, 0, "no prompts should fire when --from provides all values");
      assert.equal(results.length, 3, "should have 3 results");
      assert.ok(results.every((r) => r.ok));
    } finally {
      restoreVars(saved);
    }
  });

  // ── Test 9: interactive populate never prompts for SLACK_SIGNING_SECRET ────────────
  test("interactive mode never prompts for SLACK_SIGNING_SECRET", async () => {
    // signing_secret is not needed for socket-mode — populate must not ask for it
    const allVars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "ANTHROPIC_API_KEY"];
    const saved = clearVars(allVars);

    const promptedLabels: string[] = [];
    const promptFn = makePromptStub(["xoxb-bot", "xapp-app", "sk-ant-key"]);
    const trackingPromptFn = async (p: string) => {
      promptedLabels.push(p);
      return promptFn(p);
    };

    try {
      const results = await populateSecrets({
        fleet: fleetFile,
        dryRun: true,
        agent: ["conductor"],
        interactive: true,
        promptFn: trackingPromptFn,
        confirmFn: makeConfirmStub(true),
      });

      assert.equal(results.length, 3, "should produce 3 results");
      assert.ok(results.every((r) => r.ok));

      // Verify no prompt mentioned signing_secret or SLACK_SIGNING_SECRET
      const signingPrompt = promptedLabels.find((p) =>
        p.toLowerCase().includes("signing") || p.toUpperCase().includes("SIGNING_SECRET")
      );
      assert.equal(
        signingPrompt,
        undefined,
        `populate must not prompt for signing_secret; got: ${signingPrompt}`
      );
    } finally {
      restoreVars(saved);
    }
  });
});

// ── materializeHostEnv (local ~/.openclaw/.env) ──────────────────────────────

describe("materializeHostEnv", () => {
  // Two agents on one local host; conductor inherits the anthropic default,
  // pixel overrides to openai. Built directly (no env expansion) so the slack
  // ${VAR} placeholders survive — the shape `fleetmind up` loads.
  function hostFleet() {
    return normalizeFleet(
      FleetSchema.parse({
        fleet: { name: "demo" },
        targets: {
          box: { provider: "local", os: "macos", service_manager: "launchd", workspace_base: "/Users/oc/.openclaw" },
        },
        agents: {
          defaults: { target: "box", model: "anthropic/claude-sonnet-4-6" },
          list: [
            {
              id: "conductor", name: "C", providers: ["anthropic"],
              channels: [{ provider: "slack", account_id: "conductor", bot_token: "${CONDUCTOR_BOT_TOKEN}", app_token: "${CONDUCTOR_APP_TOKEN}" }],
            },
            {
              id: "pixel", name: "P", model: "openai/gpt-4o", providers: ["openai"],
              channels: [{ provider: "slack", account_id: "pixel", bot_token: "${PIXEL_BOT_TOKEN}", app_token: "${PIXEL_APP_TOKEN}" }],
            },
          ],
        },
      })
    );
  }

  test("resolves slack placeholders + per-provider keys for the host's agents", () => {
    const env = {
      CONDUCTOR_BOT_TOKEN: "xoxb-c", CONDUCTOR_APP_TOKEN: "xapp-c",
      PIXEL_BOT_TOKEN: "xoxb-p", PIXEL_APP_TOKEN: "xapp-p",
      ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai",
    };
    const { vars, missing } = materializeHostEnv(hostFleet(), "box", env);
    assert.deepEqual(missing, []);
    // Slack tokens keyed by their fleet.yaml placeholder name…
    assert.equal(vars["CONDUCTOR_BOT_TOKEN"], "xoxb-c");
    assert.equal(vars["PIXEL_APP_TOKEN"], "xapp-p");
    // …and one model key per provider used on the host.
    assert.equal(vars["ANTHROPIC_API_KEY"], "sk-ant"); // conductor (default model)
    assert.equal(vars["OPENAI_API_KEY"], "sk-oai");    // pixel (override)
  });

  test("reports unresolved vars as missing", () => {
    // Slack present, but no provider keys in env → both providers missing.
    const { missing } = materializeHostEnv(hostFleet(), "box", {
      CONDUCTOR_BOT_TOKEN: "x", CONDUCTOR_APP_TOKEN: "y",
      PIXEL_BOT_TOKEN: "z", PIXEL_APP_TOKEN: "w",
    });
    assert.ok(missing.includes("ANTHROPIC_API_KEY"));
    assert.ok(missing.includes("OPENAI_API_KEY"));
  });
});
