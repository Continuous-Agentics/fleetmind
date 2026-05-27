/**
 * Unit tests for `fleetmind slack manifests`.
 *
 * Uses dependency injection (writeFn, mkdirFn) to avoid live file-system writes
 * where convenient; also tests actual temp-dir writes for round-trip YAML validation.
 *
 * Covers:
 *   - Default manifest for a pm-bot matches reference structure (field assertions)
 *   - Default manifest for a backend-worker uses #8B4513 background colour
 *   - --agent filter writes only the specified agent's file
 *   - --out <dir> writes to the specified directory
 *   - Per-agent slack.background_color override is honoured
 *   - Per-agent slack.long_description override is honoured
 *   - slack.extra_scopes appended after defaults (no duplicates)
 *   - slack.extra_events appended after defaults (no duplicates)
 *   - Output file is valid YAML that parses back to the same structure
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  buildManifest,
  generateManifests,
  ROLE_BACKGROUND_COLORS,
  DEFAULT_SCOPES,
  DEFAULT_EVENTS,
  type ManifestAgentInput,
  type ManifestsOptions,
} from "../cli/commands/slack.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let fleetPath: string;

/** Write a minimal fleet.yaml to tmpDir and return its path. */
function writeFleet(content: string): string {
  const p = path.join(tmpDir, "fleet.yaml");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

const FLEET_TWO_AGENTS = `
fleet:
  name: test-fleet

agents:
  list:
    - id: conductor
      name: Conductor
      role: pm
      description: "PM bot for test-fleet"
      channels:
        - provider: slack
          account_id: conductor
          bot_token: "\${CONDUCTOR_BOT_TOKEN}"
          app_token: "\${CONDUCTOR_APP_TOKEN}"

    - id: forge
      name: Forge
      role: backend-worker
      description: "Backend worker bot for test-fleet"
      channels:
        - provider: slack
          account_id: forge
          bot_token: "\${FORGE_BOT_TOKEN}"
          app_token: "\${FORGE_APP_TOKEN}"
`.trimStart();

const FLEET_WITH_OVERRIDES = `
fleet:
  name: override-fleet

agents:
  list:
    - id: custom
      name: Custom
      role: pm
      description: "Custom pm bot"
      channels:
        - provider: slack
          account_id: custom
          bot_token: "\${CUSTOM_BOT_TOKEN}"
          app_token: "\${CUSTOM_APP_TOKEN}"
          background_color: "#123456"
          long_description: "This is my custom long description."
          extra_scopes:
            - bookmarks:read
            - channels:history
          extra_events:
            - app_mention
            - file_shared
`.trimStart();

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-slack-manifests-"));
  fleetPath = writeFleet(FLEET_TWO_AGENTS);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildManifest", () => {
  test("pm-bot has correct display_information fields", () => {
    const agent: ManifestAgentInput = {
      id: "conductor",
      name: "Conductor",
      role: "pm",
      description: "PM bot for test-fleet",
    };
    const manifest = buildManifest(agent, "test-fleet");
    const info = manifest.display_information as Record<string, unknown>;

    assert.equal(info.name, "Conductor");
    assert.equal(info.description, "PM bot for test-fleet");
    assert.equal(info.background_color, ROLE_BACKGROUND_COLORS["pm"]);
    assert.ok(
      typeof info.long_description === "string" && info.long_description.length > 0,
      "long_description should be non-empty"
    );
  });

  test("backend-worker uses #8B4513 background colour by default", () => {
    const agent: ManifestAgentInput = {
      id: "forge",
      name: "Forge",
      role: "backend-worker",
      description: "Backend worker",
    };
    const manifest = buildManifest(agent, "test-fleet");
    const info = manifest.display_information as Record<string, unknown>;
    assert.equal(info.background_color, "#8B4513");
  });

  test("features.bot_user is always_online with agent name as display_name", () => {
    const agent: ManifestAgentInput = { id: "forge", name: "Forge", role: "worker" };
    const manifest = buildManifest(agent, "test-fleet");
    const botUser = (manifest.features as Record<string, unknown>).bot_user as Record<string, unknown>;
    assert.equal(botUser.display_name, "Forge");
    assert.equal(botUser.always_online, true);
  });

  test("default scopes are present in oauth_config", () => {
    const agent: ManifestAgentInput = { id: "a", name: "A", role: "worker" };
    const manifest = buildManifest(agent, "test-fleet");
    const scopes = (
      (manifest.oauth_config as Record<string, unknown>).scopes as Record<string, unknown>
    ).bot as string[];
    for (const s of DEFAULT_SCOPES) {
      assert.ok(scopes.includes(s), `Missing default scope: ${s}`);
    }
  });

  test("default events are present in settings.event_subscriptions", () => {
    const agent: ManifestAgentInput = { id: "a", name: "A", role: "worker" };
    const manifest = buildManifest(agent, "test-fleet");
    const events = (
      (manifest.settings as Record<string, unknown>).event_subscriptions as Record<string, unknown>
    ).bot_events as string[];
    for (const e of DEFAULT_EVENTS) {
      assert.ok(events.includes(e), `Missing default event: ${e}`);
    }
  });

  test("settings has correct static flags", () => {
    const agent: ManifestAgentInput = { id: "a", name: "A", role: "worker" };
    const manifest = buildManifest(agent, "test-fleet");
    const settings = manifest.settings as Record<string, unknown>;
    assert.equal(settings.org_deploy_enabled, false);
    assert.equal(settings.socket_mode_enabled, true);
    assert.equal(settings.token_rotation_enabled, false);
    assert.deepEqual(settings.interactivity, { is_enabled: true });
  });

  test("per-agent background_color override is honoured", () => {
    const agent: ManifestAgentInput = {
      id: "custom",
      name: "Custom",
      role: "pm",
      channels: [{ provider: "slack", background_color: "#ABCDEF" }],
    };
    const manifest = buildManifest(agent, "test-fleet");
    const info = manifest.display_information as Record<string, unknown>;
    assert.equal(info.background_color, "#ABCDEF");
  });

  test("per-agent long_description override is honoured", () => {
    const agent: ManifestAgentInput = {
      id: "custom",
      name: "Custom",
      role: "pm",
      channels: [{ provider: "slack", long_description: "My custom long description." }],
    };
    const manifest = buildManifest(agent, "test-fleet");
    const info = manifest.display_information as Record<string, unknown>;
    assert.equal(info.long_description, "My custom long description.");
  });

  test("extra_scopes appended after defaults with no duplicates", () => {
    const agent: ManifestAgentInput = {
      id: "a",
      name: "A",
      role: "worker",
      channels: [{ provider: "slack", extra_scopes: ["bookmarks:read", "channels:history"] }],
    };
    const manifest = buildManifest(agent, "test-fleet");
    const scopes = (
      (manifest.oauth_config as Record<string, unknown>).scopes as Record<string, unknown>
    ).bot as string[];

    // bookmarks:read is new — should be present
    assert.ok(scopes.includes("bookmarks:read"), "extra scope should be present");
    // channels:history is a default — should appear exactly once
    const count = scopes.filter((s) => s === "channels:history").length;
    assert.equal(count, 1, "channels:history should appear exactly once");
    // Extra scope appears after the defaults (i.e. after the last default)
    const lastDefaultIdx = Math.max(...DEFAULT_SCOPES.map((s) => scopes.indexOf(s)));
    const extraIdx = scopes.indexOf("bookmarks:read");
    assert.ok(extraIdx > lastDefaultIdx, "extra scope should be after defaults");
  });

  test("extra_events appended after defaults with no duplicates", () => {
    const agent: ManifestAgentInput = {
      id: "a",
      name: "A",
      role: "worker",
      channels: [{ provider: "slack", extra_events: ["file_shared", "app_mention"] }],
    };
    const manifest = buildManifest(agent, "test-fleet");
    const events = (
      (manifest.settings as Record<string, unknown>).event_subscriptions as Record<string, unknown>
    ).bot_events as string[];

    assert.ok(events.includes("file_shared"), "extra event should be present");
    const count = events.filter((e) => e === "app_mention").length;
    assert.equal(count, 1, "app_mention should appear exactly once");
    const lastDefaultIdx = Math.max(...DEFAULT_EVENTS.map((e) => events.indexOf(e)));
    const extraIdx = events.indexOf("file_shared");
    assert.ok(extraIdx > lastDefaultIdx, "extra event should be after defaults");
  });
});

describe("generateManifests", () => {
  test("writes one file per agent when no --agent filter", async () => {
    const written: Array<{ path: string; content: string }> = [];
    const opts: ManifestsOptions = {
      fleet: fleetPath,
      out: path.join(tmpDir, "out"),
      agent: [],
      mkdirFn: () => {},
      writeFn: (p, c) => written.push({ path: p, content: c }),
    };
    const result = await generateManifests(opts);
    assert.equal(result.written.length, 2);
    const ids = result.written.map((w) => w.agentId).sort();
    assert.deepEqual(ids, ["conductor", "forge"]);
  });

  test("--agent filter writes only the specified agent", async () => {
    const written: Array<{ path: string; content: string }> = [];
    const outDir = path.join(tmpDir, "filtered");
    const opts: ManifestsOptions = {
      fleet: fleetPath,
      out: outDir,
      agent: ["forge"],
      mkdirFn: () => {},
      writeFn: (p, c) => written.push({ path: p, content: c }),
    };
    const result = await generateManifests(opts);
    assert.equal(result.written.length, 1);
    assert.equal(result.written[0].agentId, "forge");
  });

  test("--out writes to the specified directory", async () => {
    const outDir = path.join(tmpDir, "custom-out");
    const opts: ManifestsOptions = {
      fleet: fleetPath,
      out: outDir,
      agent: [],
    };
    const result = await generateManifests(opts);
    assert.equal(result.written.length, 2);
    for (const w of result.written) {
      assert.ok(
        w.filePath.startsWith(path.resolve(outDir)),
        `Expected file in ${outDir}, got ${w.filePath}`
      );
      assert.ok(fs.existsSync(w.filePath), `Expected file to exist: ${w.filePath}`);
    }
  });

  test("output file is valid YAML and parses back to same structure", async () => {
    const outDir = path.join(tmpDir, "yaml-roundtrip");
    const opts: ManifestsOptions = {
      fleet: fleetPath,
      out: outDir,
      agent: ["conductor"],
    };
    const result = await generateManifests(opts);
    assert.equal(result.written.length, 1);

    const content = fs.readFileSync(result.written[0].filePath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    // Verify round-trip structure is intact
    assert.ok(parsed.display_information, "display_information should be present");
    assert.ok(parsed.features, "features should be present");
    assert.ok(parsed.oauth_config, "oauth_config should be present");
    assert.ok(parsed.settings, "settings should be present");

    const info = parsed.display_information as Record<string, unknown>;
    assert.equal(info.name, "Conductor");
    assert.equal(info.background_color, ROLE_BACKGROUND_COLORS["pm"]);
  });

  test("honours per-agent overrides in fleet.yaml", async () => {
    const overridePath = writeFleet(FLEET_WITH_OVERRIDES);
    const written: Array<{ path: string; content: string }> = [];
    const opts: ManifestsOptions = {
      fleet: overridePath,
      out: path.join(tmpDir, "override-out"),
      agent: [],
      mkdirFn: () => {},
      writeFn: (p, c) => written.push({ path: p, content: c }),
    };
    const result = await generateManifests(opts);
    assert.equal(result.written.length, 1);

    const content = written[0].content;
    const parsed = parseYaml(content) as Record<string, unknown>;
    const info = parsed.display_information as Record<string, unknown>;

    assert.equal(info.background_color, "#123456");
    assert.equal(info.long_description, "This is my custom long description.");

    // extra_scopes: bookmarks:read added; channels:history deduped
    const scopes = (
      (parsed.oauth_config as Record<string, unknown>).scopes as Record<string, unknown>
    ).bot as string[];
    assert.ok(scopes.includes("bookmarks:read"));
    assert.equal(scopes.filter((s) => s === "channels:history").length, 1);

    // extra_events: file_shared added; app_mention deduped
    const events = (
      (parsed.settings as Record<string, unknown>).event_subscriptions as Record<string, unknown>
    ).bot_events as string[];
    assert.ok(events.includes("file_shared"));
    assert.equal(events.filter((e) => e === "app_mention").length, 1);
  });
});
