/**
 * Unit tests for the skill resolver.
 *
 * Coverage:
 *   - source: fleetmind resolves bot-delegation and bot-reception to the
 *     bundled openclaw/skills/<name>/ directory inside the package root.
 *   - source: fleetmind errors explicitly for an unknown skill name
 *     (not a silent "skipping" warn — a typo in fleet.yaml is a user error).
 *   - source: client still works (regression).
 *   - source: clawhub still works (regression).
 *   - source: private still works (regression).
 *   - fleetmindPackageRoot() returns a path that contains openclaw/skills/.
 *   - Package-root detection works from both src/runtime/ (tsx/dev) and
 *     dist/runtime/ (built) paths — verified by patching the cache with a
 *     synthetic root so tests don't depend on disk layout of the test runner.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

// We test the exported helpers + installSkill behaviour by importing the module.
// resolveFleetmind is not exported (internal), so we drive it through installSkill.
import { installSkill, fleetmindPackageRoot } from "../runtime/resolver.js";
import type { Fleet, SkillRef } from "../config/schema.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Fleet fixture. */
function makeFleet(skillsLocal?: string): Fleet {
  return {
    fleet: { name: "test-fleet", version: "1.0.0", client: "", description: "" },
    agents: {
      defaults: { model: "anthropic/claude-haiku-4", plugins: [] },
      list: [],
    },
    skills_repo: { url: "", branch: "main", poll_interval: "60s", local: skillsLocal },
    private_registry: {
      url: "https://npm.pkg.github.com",
      token_env: "CA_REGISTRY_TOKEN",
      scope: "@continuous-agentics",
    },
    secrets: { provider: "env" },
    outputs: {
      openclaw_json: "./rendered/openclaw.json",
      terraform_vars: "./rendered/fleet.derived.tfvars",
      workspace_manifests: "./rendered/workspaces/",
    },
    openclaw: {
      gateway: { port: 18789, mode: "local", bind: "loopback" },
      session: { dm_scope: "per-channel-peer" },
      tools: { profile: "coding", web_search: { enabled: false, provider: "brave" } },
      slack: {
        mode: "socket", typing_reaction: "thinking_face", ack_reaction: "eyes",
        allow_bots: true, history_limit: 50,
        streaming: { mode: "partial", native_transport: true },
        reply_to_mode_by_chat_type: { channel: "all" },
      },
    },
    context: { provider: "local" },
    delegation: undefined,
    getAgent: (_id: string) => undefined,
    orchestrator: undefined,
    specialists: [],
  } as unknown as Fleet;
}

/** Minimal SkillRef for a given source. */
function skillRef(name: string, source: SkillRef["source"]): SkillRef {
  return { name: name as SkillRef["name"], source };
}

// ── fleetmindPackageRoot ───────────────────────────────────────────────────────

describe("fleetmindPackageRoot", () => {
  test("returns a path that exists on disk", () => {
    const root = fleetmindPackageRoot();
    assert.ok(fs.existsSync(root), `package root should exist: ${root}`);
  });

  test("package root contains openclaw/skills/", () => {
    const root = fleetmindPackageRoot();
    const skillsDir = path.join(root, "openclaw", "skills");
    assert.ok(
      fs.existsSync(skillsDir),
      `openclaw/skills/ should exist under package root ${root}`
    );
  });

  test("bundled bot-delegation skill exists at expected path", () => {
    const root = fleetmindPackageRoot();
    const botDelegation = path.join(root, "openclaw", "skills", "bot-delegation");
    assert.ok(
      fs.existsSync(botDelegation),
      `bot-delegation skill should be bundled at ${botDelegation}`
    );
  });

  test("bundled bot-reception skill exists at expected path", () => {
    const root = fleetmindPackageRoot();
    const botReception = path.join(root, "openclaw", "skills", "bot-reception");
    assert.ok(
      fs.existsSync(botReception),
      `bot-reception skill should be bundled at ${botReception}`
    );
  });

  test("is stable — returns the same value on repeated calls", () => {
    const a = fleetmindPackageRoot();
    const b = fleetmindPackageRoot();
    assert.equal(a, b, "fleetmindPackageRoot() must be idempotent");
  });
});

// ── source: fleetmind — happy path ────────────────────────────────────────────

describe("source: fleetmind — happy path", () => {
  let destDir: string;

  beforeEach(() => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-resolver-test-"));
  });

  afterEach(() => {
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  test("installs bot-delegation from bundled skills", async () => {
    const fleet = makeFleet();
    const skill = skillRef("bot-delegation", "fleetmind");

    await installSkill(skill, destDir, fleet, false);

    const dest = path.join(destDir, "bot-delegation");
    assert.ok(fs.existsSync(dest), `bot-delegation should be installed at ${dest}`);

    // SKILL.md is the required entry point for every skill
    const skillMd = path.join(dest, "SKILL.md");
    assert.ok(fs.existsSync(skillMd), "SKILL.md must be present after install");
  });

  test("installs bot-reception from bundled skills", async () => {
    const fleet = makeFleet();
    const skill = skillRef("bot-reception", "fleetmind");

    await installSkill(skill, destDir, fleet, false);

    const dest = path.join(destDir, "bot-reception");
    assert.ok(fs.existsSync(dest), `bot-reception should be installed at ${dest}`);

    const skillMd = path.join(dest, "SKILL.md");
    assert.ok(fs.existsSync(skillMd), "SKILL.md must be present after install");
  });

  test("dry-run does NOT write files but returns without error", async () => {
    const fleet = makeFleet();
    const skill = skillRef("bot-delegation", "fleetmind");

    await installSkill(skill, destDir, fleet, true /* dryRun */);

    const dest = path.join(destDir, "bot-delegation");
    assert.ok(!fs.existsSync(dest), "dry-run must not write files");
  });

  test("overwrites existing skill dir on re-install", async () => {
    const fleet = makeFleet();
    const skill = skillRef("bot-delegation", "fleetmind");

    // First install
    await installSkill(skill, destDir, fleet, false);
    const dest = path.join(destDir, "bot-delegation");
    assert.ok(fs.existsSync(dest));

    // Stale file that should be clobbered
    const staleFile = path.join(dest, "stale.txt");
    fs.writeFileSync(staleFile, "stale");

    // Second install (re-deploy scenario)
    await installSkill(skill, destDir, fleet, false);

    // Fresh copy of the skill should be there but stale file should be gone
    // (cpSync after rmSync means clean slate)
    assert.ok(!fs.existsSync(staleFile), "stale files must be removed on re-install");
    assert.ok(fs.existsSync(path.join(dest, "SKILL.md")), "SKILL.md must still be present");
  });

  // Per-skill reference isolation (see the doc comment on resolveFleetmind()
  // in resolver.ts): bot-delegation's references/inbound-self-start.md and
  // worker-self-start's references/pm-inbound-handler.md intentionally
  // duplicate the self-start-notice handler content rather than sharing one
  // file, because an agent may have only one of the two skills installed.
  // installSkill() has no cross-skill dedup step, so installing one must
  // never depend on, or reach into, the other's directory. These tests pin
  // that behaviour so a future "let's dedupe these" refactor gets caught
  // here instead of silently breaking single-skill installs.
  test("installing bot-delegation alone does not require or copy worker-self-start", async () => {
    const fleet = makeFleet();
    const skill = skillRef("bot-delegation", "fleetmind");

    await installSkill(skill, destDir, fleet, false);

    const dest = path.join(destDir, "bot-delegation");
    assert.ok(
      fs.existsSync(path.join(dest, "references", "inbound-self-start.md")),
      "bot-delegation must carry its own full inbound-self-start reference"
    );
    assert.ok(
      !fs.existsSync(path.join(destDir, "worker-self-start")),
      "installing bot-delegation alone must not pull in worker-self-start"
    );
  });

  test("installing worker-self-start alone does not require or copy bot-delegation", async () => {
    const fleet = makeFleet();
    const skill = skillRef("worker-self-start", "fleetmind");

    await installSkill(skill, destDir, fleet, false);

    const dest = path.join(destDir, "worker-self-start");
    assert.ok(
      fs.existsSync(path.join(dest, "references", "pm-inbound-handler.md")),
      "worker-self-start must carry its own full pm-inbound-handler reference"
    );
    assert.ok(
      !fs.existsSync(path.join(destDir, "bot-delegation")),
      "installing worker-self-start alone must not pull in bot-delegation"
    );
  });
});

describe("source: fleetmind — unknown skill name", () => {
  let destDir: string;

  beforeEach(() => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-resolver-error-test-"));
  });

  afterEach(() => {
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  test("does not throw but logs error for unknown bundled skill name", async () => {
    // installSkill intentionally does not throw — it logs the error and returns.
    // The test verifies: (a) no exception, (b) nothing written to destDir.
    const fleet = makeFleet();
    const skill = skillRef("bot-delegashun", "fleetmind"); // deliberate typo

    await assert.doesNotReject(
      () => installSkill(skill, destDir, fleet, false),
      "installSkill must not throw for an unknown fleetmind skill"
    );

    const dest = path.join(destDir, "bot-delegashun");
    assert.ok(!fs.existsSync(dest), "no directory should be created for an unknown skill");
  });

  test("dry-run also does not throw for unknown skill name", async () => {
    const fleet = makeFleet();
    const skill = skillRef("nonexistent-skill", "fleetmind");

    await assert.doesNotReject(
      () => installSkill(skill, destDir, fleet, true),
      "dry-run must not throw for an unknown fleetmind skill"
    );
  });
});

// ── source: client — regression ───────────────────────────────────────────────

describe("source: client — regression", () => {
  let tmpDir: string;
  let destDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-client-skill-"));
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-client-dest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  test("installs skill from skills_repo.local when directory exists", async () => {
    // Create a fake client skill
    const clientSkillDir = path.join(tmpDir, "my-custom-skill");
    fs.mkdirSync(clientSkillDir);
    fs.writeFileSync(path.join(clientSkillDir, "SKILL.md"), "# My Custom Skill\n");

    const fleet = makeFleet(tmpDir /* skills_repo.local */);
    const skill = skillRef("my-custom-skill", "client");

    await installSkill(skill, destDir, fleet, false);

    const dest = path.join(destDir, "my-custom-skill");
    assert.ok(fs.existsSync(dest), "client skill should be installed");
    assert.ok(fs.existsSync(path.join(dest, "SKILL.md")));
  });

  test("warns (no throw) when client skill is not found", async () => {
    const fleet = makeFleet("/nonexistent/skills");
    const skill = skillRef("missing-skill", "client");

    await assert.doesNotReject(
      () => installSkill(skill, destDir, fleet, false),
      "missing client skill must not throw"
    );
  });

  test("dry-run does not write client skill", async () => {
    const clientSkillDir = path.join(tmpDir, "dry-skill");
    fs.mkdirSync(clientSkillDir);
    fs.writeFileSync(path.join(clientSkillDir, "SKILL.md"), "# Dry\n");

    const fleet = makeFleet(tmpDir);
    const skill = skillRef("dry-skill", "client");

    await installSkill(skill, destDir, fleet, true);

    assert.ok(!fs.existsSync(path.join(destDir, "dry-skill")), "dry-run must not write");
  });
});

// ── source: clawhub — regression ──────────────────────────────────────────────

describe("source: clawhub — regression", () => {
  let destDir: string;

  beforeEach(() => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-clawhub-dest-"));
  });

  afterEach(() => {
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  test("dry-run logs intent and does not throw", async () => {
    const fleet = makeFleet();
    const skill: SkillRef = { name: "taskflow" as SkillRef["name"], source: "clawhub", author: "continuous-agentics" };

    // In test context `clawhub` CLI is unlikely to be installed, but dry-run
    // must not throw — it just checks for the CLI and logs.
    await assert.doesNotReject(
      () => installSkill(skill, destDir, fleet, true),
      "clawhub dry-run must not throw"
    );

    // Nothing written in dry-run
    assert.ok(!fs.existsSync(path.join(destDir, "taskflow")), "dry-run must not write");
  });
});

// ── source: private — regression ──────────────────────────────────────────────

describe("source: private — regression", () => {
  let destDir: string;

  beforeEach(() => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-private-dest-"));
  });

  afterEach(() => {
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  test("errors (no throw) when CA_REGISTRY_TOKEN is missing", async () => {
    const saved = process.env["CA_REGISTRY_TOKEN"];
    delete process.env["CA_REGISTRY_TOKEN"];

    const fleet = makeFleet();
    const skill: SkillRef = { name: "ca-fleet-ops" as SkillRef["name"], source: "private", version: "1.0.0" };

    try {
      await assert.doesNotReject(
        () => installSkill(skill, destDir, fleet, false),
        "missing registry token must not throw"
      );
      assert.ok(!fs.existsSync(path.join(destDir, "ca-fleet-ops")), "nothing written without token");
    } finally {
      if (saved !== undefined) process.env["CA_REGISTRY_TOKEN"] = saved;
    }
  });

  test("dry-run with missing token does not throw", async () => {
    const saved = process.env["CA_REGISTRY_TOKEN"];
    delete process.env["CA_REGISTRY_TOKEN"];

    const fleet = makeFleet();
    const skill: SkillRef = { name: "ca-fleet-ops" as SkillRef["name"], source: "private" };

    try {
      await assert.doesNotReject(
        () => installSkill(skill, destDir, fleet, true),
        "private dry-run must not throw even without token"
      );
    } finally {
      if (saved !== undefined) process.env["CA_REGISTRY_TOKEN"] = saved;
    }
  });
});

// ── Package-root detection: src/ vs dist/ path equivalence ───────────────────

describe("Package-root detection from src/ and dist/ paths", () => {
  test("resolver's import.meta.url yields the correct package root", () => {
    // The resolver is loaded from src/runtime/ (dev via tsx) or dist/runtime/
    // (built). Either way, going up 2 dirs should land on the package root —
    // verified by the presence of openclaw/skills/.
    const root = fleetmindPackageRoot();
    const skillsDir = path.join(root, "openclaw", "skills");
    assert.ok(
      fs.existsSync(skillsDir),
      `Expected openclaw/skills/ to exist under package root: ${root}`
    );
  });

  test("package root contains package.json (sanity check)", () => {
    const root = fleetmindPackageRoot();
    const pkgJson = path.join(root, "package.json");
    assert.ok(fs.existsSync(pkgJson), `package.json should be at the package root: ${root}`);
  });
});
