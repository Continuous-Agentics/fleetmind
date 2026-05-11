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
  resolveAnthropic,
  loadEnvFile,
  redact,
  populateSecrets,
  type PopulateOptions,
} from "../cli/commands/populate.js";

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
    CONDUCTOR_SIGNING_SECRET: "signingsecret123",
  };

  const slack = {
    account_id: "conductor",
    bot_token: "${CONDUCTOR_BOT_TOKEN}",
    app_token: "${CONDUCTOR_APP_TOKEN}",
    signing_secret: "${CONDUCTOR_SIGNING_SECRET}",
  };

  test("resolves all three Slack fields when env vars are set", () => {
    const res = resolveSlack("conductor", slack, env);
    assert.equal(res.ok, true);
    assert.equal(res.values.SLACK_BOT_TOKEN, "xoxb-bot");
    assert.equal(res.values.SLACK_APP_TOKEN, "xapp-app");
    assert.equal(res.values.SLACK_SIGNING_SECRET, "signingsecret123");
    assert.deepEqual(res.missing, []);
  });

  test("reports missing env vars when not set", () => {
    const res = resolveSlack("conductor", slack, {});
    assert.equal(res.ok, false);
    assert.ok(res.missing.includes("CONDUCTOR_BOT_TOKEN"));
    assert.ok(res.missing.includes("CONDUCTOR_APP_TOKEN"));
    assert.ok(res.missing.includes("CONDUCTOR_SIGNING_SECRET"));
  });

  test("partial resolution — only missing vars reported", () => {
    const partialEnv = { CONDUCTOR_BOT_TOKEN: "xoxb-bot" };
    const res = resolveSlack("conductor", slack, partialEnv);
    assert.equal(res.ok, false);
    assert.equal(res.missing.length, 2);
    assert.ok(res.missing.includes("CONDUCTOR_APP_TOKEN"));
  });

  test("handles literal values (not placeholders)", () => {
    const literalSlack = {
      account_id: "test",
      bot_token: "xoxb-literal",
      app_token: "xapp-literal",
      signing_secret: "literal-secret",
    };
    const res = resolveSlack("test", literalSlack, {});
    assert.equal(res.ok, true);
    assert.equal(res.values.SLACK_BOT_TOKEN, "xoxb-literal");
  });
});

// ── resolveAnthropic ──────────────────────────────────────────────────────────

describe("resolveAnthropic", () => {
  test("per-agent env var takes precedence", () => {
    const env = {
      CONDUCTOR_ANTHROPIC_API_KEY: "sk-ant-per-agent",
      ANTHROPIC_API_KEY: "sk-ant-fleet-wide",
    };
    const res = resolveAnthropic("conductor", undefined, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-per-agent");
  });

  test("falls back to fleet-wide ANTHROPIC_API_KEY", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-fleet-wide" };
    const res = resolveAnthropic("conductor", undefined, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-fleet-wide");
  });

  test("resolves anthropic.api_key field placeholder", () => {
    const env = {
      MY_CUSTOM_ANTHROPIC_KEY: "sk-ant-custom",
    };
    const res = resolveAnthropic("conductor", { api_key: "${MY_CUSTOM_ANTHROPIC_KEY}" }, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-custom");
  });

  test("returns missing when no key found", () => {
    const res = resolveAnthropic("conductor", undefined, {});
    assert.equal(res.ok, false);
    assert.ok(res.missing.includes("CONDUCTOR_ANTHROPIC_API_KEY"));
  });

  test("per-agent var name is UPPER + _ANTHROPIC_API_KEY", () => {
    const env = { FORGE_ANTHROPIC_API_KEY: "sk-ant-forge" };
    const res = resolveAnthropic("forge", undefined, env);
    assert.equal(res.ok, true);
    assert.equal(res.value, "sk-ant-forge");
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

// ── populateSecrets — dry-run ─────────────────────────────────────────────────

describe("populateSecrets dry-run", () => {
  let tmpDir: string;
  let fleetFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-fleet-"));
    fleetFile = path.join(tmpDir, "fleet.yaml");

    // Write a minimal fleet.yaml
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
      slack:
        account_id: conductor
        bot_token: "\${CONDUCTOR_BOT_TOKEN}"
        app_token: "\${CONDUCTOR_APP_TOKEN}"
        signing_secret: "\${CONDUCTOR_SIGNING_SECRET}"
    - id: forge
      name: Forge
      slack:
        account_id: forge
        bot_token: "\${FORGE_BOT_TOKEN}"
        app_token: "\${FORGE_APP_TOKEN}"
        signing_secret: "\${FORGE_SIGNING_SECRET}"
`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("dry-run returns 4 results without calling AWS", async () => {
    const opts: PopulateOptions = {
      fleet: fleetFile,
      dryRun: true,
      agent: [],
    };

    // Set all required env vars
    const savedEnv: Record<string, string | undefined> = {};
    const vars = [
      "CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "CONDUCTOR_SIGNING_SECRET",
      "FORGE_BOT_TOKEN", "FORGE_APP_TOKEN", "FORGE_SIGNING_SECRET",
      "ANTHROPIC_API_KEY",
    ];
    for (const v of vars) {
      savedEnv[v] = process.env[v];
      process.env[v] = `test-${v.toLowerCase()}`;
    }

    try {
      const results = await populateSecrets(opts);

      // Should have 4 results: conductor/slack, conductor/anthropic, forge/slack, forge/anthropic
      assert.equal(results.length, 4);

      const names = results.map((r) => r.secretName);
      assert.ok(names.includes("test-fleet/agents/conductor/slack"));
      assert.ok(names.includes("test-fleet/agents/conductor/anthropic"));
      assert.ok(names.includes("test-fleet/agents/forge/slack"));
      assert.ok(names.includes("test-fleet/agents/forge/anthropic"));

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
    const vars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "CONDUCTOR_SIGNING_SECRET", "ANTHROPIC_API_KEY"];
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

      assert.equal(results.length, 2);
      assert.equal(results[0]!.secretName, "test-fleet/agents/conductor/slack");
      assert.equal(results[1]!.secretName, "test-fleet/agents/conductor/anthropic");
    } finally {
      for (const v of vars) {
        if (savedEnv[v] === undefined) delete process.env[v];
        else process.env[v] = savedEnv[v];
      }
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
    const vars = ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "CONDUCTOR_SIGNING_SECRET", "ANTHROPIC_API_KEY"];
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
      assert.equal(results.length, 2);
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
      "CONDUCTOR_SIGNING_SECRET=secret-from-file",
      "ANTHROPIC_API_KEY=sk-ant-from-file",
    ].join("\n"));

    // Make sure these are NOT in process.env
    const savedVars: Record<string, string | undefined> = {};
    for (const v of ["CONDUCTOR_BOT_TOKEN", "CONDUCTOR_APP_TOKEN", "CONDUCTOR_SIGNING_SECRET", "ANTHROPIC_API_KEY"]) {
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

      const anthropicRes = results.find((r) => r.secretType === "anthropic");
      assert.ok(anthropicRes);
      assert.equal(anthropicRes.ok, true, "anthropic should resolve from env file");
    } finally {
      for (const [k, v] of Object.entries(savedVars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
