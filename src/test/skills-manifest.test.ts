/**
 * Tests for skills-manifest.ts — manifest loading + diff computation.
 *
 * Uses a tmpdir-based fake package root with synthetic openclaw/<bot-type>/skills.yaml
 * files. This lets tests run independently of the actual bundled manifests
 * (so they don't break every time we add or remove a real bot type).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadManifestForRole,
  findMissingRequiredSkills,
  computeFleetSkillGaps,
} from "../runtime/skills-manifest.js";

let tmpRoot: string;

function writeManifest(botType: string, contents: string): void {
  const dir = path.join(tmpRoot, "openclaw", botType);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skills.yaml"), contents, "utf-8");
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-manifest-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadManifestForRole", () => {
  it("returns null when no manifest exists for the role", () => {
    const result = loadManifestForRole("pm", tmpRoot);
    assert.equal(result, null);
  });

  it("returns null for an unknown role (no bot-type mapping)", () => {
    const result = loadManifestForRole("definitely-not-a-real-role", tmpRoot);
    assert.equal(result, null);
  });

  it("parses a basic manifest with one required skill", () => {
    writeManifest(
      "pm-bot",
      `role: pm\nrequired:\n  - name: bot-delegation\n    source: fleetmind\n`,
    );
    const result = loadManifestForRole("pm", tmpRoot);
    assert.equal(result?.role, "pm");
    assert.equal(result?.required.length, 1);
    assert.equal(result?.required[0].name, "bot-delegation");
    assert.equal(result?.required[0].source, "fleetmind");
  });

  it("handles a ClaWHub skill with author + version", () => {
    writeManifest(
      "backend-worker-bot",
      `role: backend-worker
required:
  - name: structured-pr-review
    source: clawhub
    author: ggettert
    version: "1.2.0"
`,
    );
    const result = loadManifestForRole("backend-worker", tmpRoot);
    assert.equal(result?.required.length, 1);
    assert.equal(result?.required[0].author, "ggettert");
    assert.equal(result?.required[0].version, "1.2.0");
  });

  it("defaults source to 'fleetmind' when omitted", () => {
    writeManifest(
      "pm-bot",
      `role: pm\nrequired:\n  - name: bot-delegation\n`,
    );
    const result = loadManifestForRole("pm", tmpRoot);
    assert.equal(result?.required[0].source, "fleetmind");
  });

  it("ignores commented-out entries", () => {
    writeManifest(
      "pm-bot",
      `role: pm
required:
  - name: bot-delegation
    source: fleetmind
  # - name: future-skill
  #   source: fleetmind
`,
    );
    const result = loadManifestForRole("pm", tmpRoot);
    assert.equal(result?.required.length, 1);
    assert.equal(result?.required[0].name, "bot-delegation");
  });

  it("throws when role in the manifest doesn't match the requested role", () => {
    writeManifest(
      "pm-bot",
      `role: worker\nrequired:\n  - name: bot-reception\n    source: fleetmind\n`,
    );
    assert.throws(() => loadManifestForRole("pm", tmpRoot), /declares role="worker" but expected "pm"/);
  });

  it("returns empty required list when none declared", () => {
    writeManifest("pm-bot", `role: pm\nrequired: []\n`);
    const result = loadManifestForRole("pm", tmpRoot);
    assert.equal(result?.required.length, 0);
  });
});

describe("findMissingRequiredSkills", () => {
  it("returns empty when all required skills are declared", () => {
    const manifest = {
      role: "pm",
      required: [{ name: "bot-delegation", source: "fleetmind" as const }],
    };
    const agentSkills = [{ name: "bot-delegation" }];
    assert.equal(findMissingRequiredSkills(agentSkills, manifest).length, 0);
  });

  it("returns the missing skill when not declared", () => {
    const manifest = {
      role: "pm",
      required: [
        { name: "bot-delegation", source: "fleetmind" as const },
        { name: "fleet-context", source: "fleetmind" as const },
      ],
    };
    const agentSkills = [{ name: "bot-delegation" }];
    const missing = findMissingRequiredSkills(agentSkills, manifest);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, "fleet-context");
  });

  it("matches by name only — version differences do not trigger re-add", () => {
    const manifest = {
      role: "backend-worker",
      required: [{ name: "structured-pr-review", source: "clawhub" as const, author: "ggettert", version: "2.0.0" }],
    };
    // Agent has the skill but pinned to a different version
    const agentSkills = [{ name: "structured-pr-review" }];
    assert.equal(findMissingRequiredSkills(agentSkills, manifest).length, 0);
  });

  it("handles agent with no skills declared at all", () => {
    const manifest = {
      role: "pm",
      required: [{ name: "bot-delegation", source: "fleetmind" as const }],
    };
    const missing = findMissingRequiredSkills([], manifest);
    assert.equal(missing.length, 1);
  });
});

describe("computeFleetSkillGaps", () => {
  beforeEach(() => {
    writeManifest(
      "pm-bot",
      `role: pm\nrequired:\n  - name: bot-delegation\n    source: fleetmind\n`,
    );
    writeManifest(
      "backend-worker-bot",
      `role: backend-worker\nrequired:\n  - name: bot-reception\n    source: fleetmind\n  - name: structured-pr-review\n    source: clawhub\n    author: ggettert\n`,
    );
  });

  it("reports gaps per agent across a mixed-role fleet", () => {
    const agents = [
      { id: "pm", role: "pm", skills: [{ name: "bot-delegation" }] },
      { id: "backend", role: "backend-worker", skills: [{ name: "bot-reception" }] },
    ];
    const gaps = computeFleetSkillGaps(agents, tmpRoot);

    assert.equal(gaps.length, 2);

    const pmGap = gaps.find((g) => g.agentId === "pm");
    assert.equal(pmGap?.missing.length, 0);

    const backendGap = gaps.find((g) => g.agentId === "backend");
    assert.equal(backendGap?.missing.length, 1);
    assert.equal(backendGap?.missing[0].name, "structured-pr-review");
  });

  it("marks manifest as null for agents whose role has no manifest", () => {
    const agents = [{ id: "mystery", role: "mystery-role", skills: [] }];
    const gaps = computeFleetSkillGaps(agents, tmpRoot);
    assert.equal(gaps[0].manifest, null);
    assert.equal(gaps[0].missing.length, 0);
  });

  it("defaults role to 'worker' when agent has no role field", () => {
    writeManifest(
      "worker-bot",
      `role: worker\nrequired:\n  - name: bot-reception\n    source: fleetmind\n`,
    );
    const agents = [{ id: "nameless", skills: [] }];
    const gaps = computeFleetSkillGaps(agents, tmpRoot);
    assert.equal(gaps[0].role, "worker");
    assert.equal(gaps[0].missing.length, 1);
  });
});
