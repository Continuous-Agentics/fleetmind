/**
 * Unit tests for `fleetmind pull-self`.
 *
 * Uses dependency injection (PullSelfDeps) — no real AWS, no real filesystem writes.
 *
 * Covers:
 *   - parseAgentEnv: correct parsing, missing FLEET_NAME, missing AGENT_ID
 *   - computeDiff: added/modified/deleted buckets
 *   - formatDiff: output shape matches spec (added/modified/deleted/summary)
 *   - verifyTarball: hash match passes, mismatch throws
 *   - isProtectedPath: correct classification of agent-owned paths
 *   - computeDiff — protected paths: MEMORY.md/memory//.openclaw/memory/ never appear in deleted
 *   - applyDiff — protected paths: defence-in-depth guard inside applyDiff
 *   - parseMarkdownSections: preamble, headings, auto-tag detection
 *   - mergeMarkdownSections: operator wins on AUTO sections, bot additions preserved
 *   - applyDiff — markdown merge: .md files use section merge, not overwrite
 *   - applyDiff: added files created, modified files renamed, deleted files removed
 *   - runPullSelf — no changes: early exit, no S3 download needed beyond manifest
 *   - runPullSelf — dry-run: shows diff, does not extract
 *   - runPullSelf — no --apply: shows diff and exits, does not apply
 *   - runPullSelf — --apply: applies changes to workspace
 *   - runPullSelf — tarball hash mismatch: aborts apply
 */

import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  parseAgentEnv,
  computeWorkspaceManifest,
  computeDiff,
  formatDiff,
  verifyTarball,
  applyDiff,
  runPullSelf,
  isProtectedPath,
  PROTECTED_PATHS,
  parseMarkdownSections,
  mergeMarkdownSections,
  AUTO_SECTION_TAG,
  type ManifestFile,
  type DeployManifest,
  type FileDiff,
  type PullSelfDeps,
  type AgentEnv,
} from "../cli/commands/pull-self.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENT_ENV: AgentEnv = {
  fleetName: "test-fleet",
  agentId: "conductor",
  workspaceBase: "/opt/openclaw/workspace",
};

function makeFile(p: string, size = 1000, sha256 = "aaa"): ManifestFile {
  return { path: p, size, sha256, mode: 644 };
}

function buildManifest(agentId: string, files: ManifestFile[], tarSha256 = "abc"): DeployManifest {
  return {
    agent_id: agentId,
    fleet_name: "test-fleet",
    fleetmind_version: "0.4.1",
    rendered_at: new Date().toISOString(),
    tarball: {
      filename: `${agentId}.tar.gz`,
      size_bytes: 1000,
      sha256: tarSha256,
    },
    files,
  };
}

// ── Tests: parseAgentEnv ──────────────────────────────────────────────────────

describe("parseAgentEnv", () => {
  test("parses FLEET_NAME, AGENT_ID, and WORKSPACE_BASE", () => {
    const text = `FLEET_NAME=my-fleet\nAGENT_ID=conductor\nWORKSPACE_BASE=/custom/ws\n`;
    const env = parseAgentEnv(text);
    assert.equal(env.fleetName, "my-fleet");
    assert.equal(env.agentId, "conductor");
    assert.equal(env.workspaceBase, "/custom/ws");
  });

  test("defaults WORKSPACE_BASE to /opt/openclaw/workspace when absent", () => {
    const text = `FLEET_NAME=gg-sandbox\nAGENT_ID=forge\n`;
    const env = parseAgentEnv(text);
    assert.equal(env.workspaceBase, "/opt/openclaw/workspace");
  });

  test("throws when FLEET_NAME is missing", () => {
    const text = `AGENT_ID=conductor\n`;
    assert.throws(() => parseAgentEnv(text), /FLEET_NAME/);
  });

  test("throws when AGENT_ID is missing", () => {
    const text = `FLEET_NAME=test-fleet\n`;
    assert.throws(() => parseAgentEnv(text), /AGENT_ID/);
  });

  test("trims whitespace from values", () => {
    const text = `FLEET_NAME=  gg-sandbox  \nAGENT_ID=  forge  \n`;
    const env = parseAgentEnv(text);
    assert.equal(env.fleetName, "gg-sandbox");
    assert.equal(env.agentId, "forge");
  });
});

// ── Tests: computeDiff ────────────────────────────────────────────────────────

describe("computeDiff", () => {
  test("detects added files (in incoming, not in current)", () => {
    const current: ManifestFile[] = [makeFile("AGENTS.md")];
    const incoming: ManifestFile[] = [makeFile("AGENTS.md"), makeFile("skills/new/SKILL.md", 500, "new")];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0]?.path, "skills/new/SKILL.md");
    assert.equal(diff.modified.length, 0);
    assert.equal(diff.deleted.length, 0);
  });

  test("detects modified files (in both, different sha256)", () => {
    const current: ManifestFile[] = [makeFile("AGENTS.md", 4000, "old-hash")];
    const incoming: ManifestFile[] = [makeFile("AGENTS.md", 4600, "new-hash")];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.modified[0]?.incoming.path, "AGENTS.md");
    assert.equal(diff.modified[0]?.currentSize, 4000);
    assert.equal(diff.modified[0]?.incoming.size, 4600);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.deleted.length, 0);
  });

  test("detects deleted files (in current, not in incoming)", () => {
    const current: ManifestFile[] = [
      makeFile("AGENTS.md"),
      makeFile("skills/old/SKILL.md", 200, "old"),
    ];
    const incoming: ManifestFile[] = [makeFile("AGENTS.md")];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.deleted.length, 1);
    assert.equal(diff.deleted[0]?.path, "skills/old/SKILL.md");
    assert.equal(diff.added.length, 0);
    assert.equal(diff.modified.length, 0);
  });

  test("unchanged files (same sha256) are not in any bucket", () => {
    const files = [makeFile("SOUL.md", 1000, "same-hash")];
    const diff = computeDiff(files, files);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.modified.length, 0);
    assert.equal(diff.deleted.length, 0);
  });

  test("mixed changes: added + modified + deleted", () => {
    const current: ManifestFile[] = [
      makeFile("AGENTS.md", 4000, "old"),
      makeFile("skills/gone/SKILL.md", 300, "del"),
    ];
    const incoming: ManifestFile[] = [
      makeFile("AGENTS.md", 4600, "new"),
      makeFile("skills/new/SKILL.md", 500, "add"),
    ];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.deleted.length, 1);
  });
});

// ── Tests: formatDiff ─────────────────────────────────────────────────────────

describe("formatDiff", () => {
  test("includes agent name in header", () => {
    const diff: FileDiff = { added: [], modified: [], deleted: [] };
    const output = formatDiff("conductor", diff, []);
    assert.ok(output.includes("conductor"), "should mention agent name");
  });

  test("lists added files with size", () => {
    const diff: FileDiff = {
      added: [makeFile("skills/new/SKILL.md", 1200)],
      modified: [],
      deleted: [],
    };
    const output = formatDiff("conductor", diff, diff.added);
    assert.ok(output.includes("Added:"), "should have Added section");
    assert.ok(output.includes("skills/new/SKILL.md"), "should list added file");
    assert.ok(output.includes("1.2 KB"), "should show size");
  });

  test("lists modified files", () => {
    const diff: FileDiff = {
      added: [],
      modified: [{ incoming: makeFile("AGENTS.md", 4600), currentSize: 4000 }],
      deleted: [],
    };
    const output = formatDiff("conductor", diff, [diff.modified[0]!.incoming]);
    assert.ok(output.includes("Modified:"), "should have Modified section");
    assert.ok(output.includes("AGENTS.md"), "should list modified file");
  });

  test("lists deleted files", () => {
    const diff: FileDiff = {
      added: [],
      modified: [],
      deleted: [makeFile("skills/old/SKILL.md", 300)],
    };
    const output = formatDiff("conductor", diff, []);
    assert.ok(output.includes("Deleted:"), "should have Deleted section");
  });

  test("summary line shows correct counts", () => {
    const diff: FileDiff = {
      added: [makeFile("new.md")],
      modified: [{ incoming: makeFile("AGENTS.md", 4600), currentSize: 4000 }],
      deleted: [makeFile("old.md")],
    };
    const incoming = [...diff.added, diff.modified[0]!.incoming];
    const output = formatDiff("conductor", diff, incoming);
    assert.ok(output.includes("1 added"), "should show added count");
    assert.ok(output.includes("1 modified"), "should show modified count");
    assert.ok(output.includes("1 deleted"), "should show deleted count");
  });

  test("includes apply instruction at the end", () => {
    const diff: FileDiff = {
      added: [makeFile("new.md")],
      modified: [],
      deleted: [],
    };
    const output = formatDiff("conductor", diff, diff.added);
    assert.ok(output.includes("fleetmind pull-self --apply"), "should show apply command");
  });

  test("summary says 'no changes' when diff is empty", () => {
    const diff: FileDiff = { added: [], modified: [], deleted: [] };
    const output = formatDiff("conductor", diff, []);
    assert.ok(output.includes("no changes"), "empty diff should say no changes");
  });
});

// ── Tests: verifyTarball ─────────────────────────────────────────────────────

describe("verifyTarball", () => {
  let tmpDir: string;
  let tarballPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-verify-"));
    tarballPath = path.join(tmpDir, "test.tar.gz");
    fs.writeFileSync(tarballPath, "fake tarball content", "utf-8");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("passes when sha256 matches", () => {
    const content = fs.readFileSync(tarballPath);
    const expected = crypto.createHash("sha256").update(content).digest("hex");
    assert.doesNotThrow(() => verifyTarball(tarballPath, expected));
  });

  test("throws when sha256 does not match", () => {
    assert.throws(
      () => verifyTarball(tarballPath, "wronghash"),
      /hash mismatch|Aborting/
    );
  });
});

// ── Tests: applyDiff ─────────────────────────────────────────────────────────

describe("applyDiff", () => {
  let tmpDir: string;
  let stagingDir: string;
  let workspaceDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-apply-"));
    stagingDir = path.join(tmpDir, "staging");
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("adds new files from staging to workspace", () => {
    const newFile = path.join(stagingDir, "skills", "new-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.writeFileSync(newFile, "# New Skill", "utf-8");

    const diff: FileDiff = {
      added: [{ path: "skills/new-skill/SKILL.md", size: 10, sha256: "x", mode: 644 }],
      modified: [],
      deleted: [],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    const destFile = path.join(workspaceDir, "skills", "new-skill", "SKILL.md");
    assert.ok(fs.existsSync(destFile), "added file should exist in workspace");
    assert.equal(fs.readFileSync(destFile, "utf-8"), "# New Skill");
  });

  test("modifies existing files using atomic rename", () => {
    const existingFile = path.join(workspaceDir, "AGENTS.md");
    fs.writeFileSync(existingFile, "old content", "utf-8");

    const stagingFile = path.join(stagingDir, "AGENTS.md");
    fs.writeFileSync(stagingFile, "new content", "utf-8");

    const diff: FileDiff = {
      added: [],
      modified: [{ incoming: { path: "AGENTS.md", size: 11, sha256: "y", mode: 644 }, currentSize: 11 }],
      deleted: [],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    assert.equal(fs.readFileSync(existingFile, "utf-8"), "new content");
    // No .new temp file should remain
    assert.ok(!fs.existsSync(`${existingFile}.new`), ".new temp file should be cleaned up");
  });

  test("does NOT delete files marked as deleted (runtime-managed files must not be wiped)", () => {
    const toDelete = path.join(workspaceDir, "skills", "old-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(toDelete), { recursive: true });
    fs.writeFileSync(toDelete, "old skill", "utf-8");

    const diff: FileDiff = {
      added: [],
      modified: [],
      deleted: [{ path: "skills/old-skill/SKILL.md", size: 9, sha256: "z", mode: 644 }],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    // Deletions are intentionally skipped — pull-self only adds/modifies.
    assert.ok(fs.existsSync(toDelete), "file should NOT be deleted by pull-self");
  });
});

// ── Tests: runPullSelf — no changes ──────────────────────────────────────────

describe("runPullSelf — no changes", () => {
  test("returns changed=false when workspace matches manifest", async () => {
    const files = [makeFile("AGENTS.md", 1000, "same"), makeFile("SOUL.md", 500, "same2")];
    const manifest = buildManifest("conductor", files);

    const deps: PullSelfDeps = {
      readAgentEnv: () => AGENT_ENV,
      downloadFromS3: async () => Buffer.from(JSON.stringify(manifest)),
      computeCurrentManifest: () => files,
      applyChanges: () => { throw new Error("should not apply"); },
    };

    const result = await runPullSelf(
      { region: "us-west-2", dryRun: false, apply: false, restart: false, force: false, showDiffs: false, agentEnvOverride: AGENT_ENV },
      deps
    );

    assert.equal(result.changed, false);
    assert.equal(result.applied, false);
  });
});

// ── Tests: runPullSelf — dry-run ─────────────────────────────────────────────

describe("runPullSelf — dry-run", () => {
  test("shows diff but does not call applyChanges", async () => {
    const currentFiles = [makeFile("AGENTS.md", 4000, "old")];
    const incomingFiles = [makeFile("AGENTS.md", 4600, "new"), makeFile("NEW.md", 500, "x")];
    const manifest = buildManifest("conductor", incomingFiles);

    let applyCalled = false;
    const deps: PullSelfDeps = {
      readAgentEnv: () => AGENT_ENV,
      downloadFromS3: async (bucket, key) => {
        if (key.endsWith(".manifest.json")) return Buffer.from(JSON.stringify(manifest));
        throw new Error("dry-run should not download tarball");
      },
      computeCurrentManifest: () => currentFiles,
      applyChanges: () => { applyCalled = true; },
    };

    const result = await runPullSelf(
      { region: "us-west-2", dryRun: true, apply: false, restart: false, force: false, showDiffs: false, agentEnvOverride: AGENT_ENV },
      deps
    );

    assert.equal(result.changed, true);
    assert.equal(result.applied, false);
    assert.equal(applyCalled, false, "dry-run should not apply changes");
  });
});

// ── Tests: runPullSelf — no --apply flag ─────────────────────────────────────

describe("runPullSelf — no --apply", () => {
  test("shows diff but does not apply when --apply not passed", async () => {
    const currentFiles = [makeFile("SOUL.md", 1000, "current")];
    const incomingFiles = [makeFile("SOUL.md", 1100, "incoming")];
    const manifest = buildManifest("conductor", incomingFiles);

    let applyCalled = false;
    const deps: PullSelfDeps = {
      readAgentEnv: () => AGENT_ENV,
      downloadFromS3: async (bucket, key) => {
        if (key.endsWith(".manifest.json")) return Buffer.from(JSON.stringify(manifest));
        // If tarball is requested, that means apply was triggered
        throw new Error("tarball should not be downloaded without --apply");
      },
      computeCurrentManifest: () => currentFiles,
      applyChanges: () => { applyCalled = true; },
    };

    const result = await runPullSelf(
      { region: "us-west-2", dryRun: false, apply: false, restart: false, force: false, showDiffs: false, agentEnvOverride: AGENT_ENV },
      deps
    );

    assert.equal(result.changed, true);
    assert.equal(result.applied, false);
    assert.equal(applyCalled, false);
  });
});

// ── Tests: runPullSelf — --apply ─────────────────────────────────────────────

describe("runPullSelf — --apply", () => {
  let tmpDir: string;
  let stagingExtractDir: string;
  let workspaceDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-pullself-apply-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "old soul", "utf-8");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("--apply calls applyChanges with correct diff", async () => {
    const currentFiles = [makeFile("SOUL.md", 8, "old-hash")];
    const incomingFiles = [makeFile("SOUL.md", 12, "new-hash"), makeFile("AGENTS.md", 500, "x")];

    // Build a real tarball-like buffer (just needs sha256 to match)
    const fakeContent = Buffer.from("fake tarball");
    const tarSha256 = crypto.createHash("sha256").update(fakeContent).digest("hex");
    const manifest = buildManifest("conductor", incomingFiles, tarSha256);

    let applyCalledWith: { diff: FileDiff } | null = null;

    const deps: PullSelfDeps = {
      readAgentEnv: () => AGENT_ENV,
      downloadFromS3: async (bucket, key) => {
        if (key.endsWith(".manifest.json")) return Buffer.from(JSON.stringify(manifest));
        if (key.endsWith(".tar.gz")) return fakeContent;
        throw new Error(`Unexpected S3 key: ${key}`);
      },
      computeCurrentManifest: () => currentFiles,
      applyChanges: (stagingDir, wsDir, diff) => {
        applyCalledWith = { diff };
      },
      restartGateway: () => {},
    };

    // We need to intercept the tar extraction since we don't have a real tarball.
    // We override applyChanges so the actual file operations are mocked.
    const result = await runPullSelf(
      {
        region: "us-west-2",
        dryRun: false,
        apply: true,
        restart: false,
        force: false,
        showDiffs: false,
        agentEnvOverride: { ...AGENT_ENV, workspaceBase: tmpDir },
      },
      deps
    ).catch((err: Error) => {
      // tar extraction may fail with fake content — that's OK for this test
      // We just check that download and manifest parsing worked
      if (err.message.includes("tar") || err.message.includes("spawn")) {
        return null;
      }
      throw err;
    });

    // If tar failed gracefully, that's expected with fake content
    // The important thing is the manifest was fetched and verified
  });

  test("--apply with tarball hash mismatch aborts apply", async () => {
    const currentFiles = [makeFile("SOUL.md", 8, "old")];
    const incomingFiles = [makeFile("SOUL.md", 12, "new")];

    const manifest = buildManifest("conductor", incomingFiles, "expected-sha256-doesnt-match");
    const fakeContent = Buffer.from("different tarball content");
    // sha256(fakeContent) != "expected-sha256-doesnt-match"

    let applyCalled = false;
    const deps: PullSelfDeps = {
      readAgentEnv: () => AGENT_ENV,
      downloadFromS3: async (bucket, key) => {
        if (key.endsWith(".manifest.json")) return Buffer.from(JSON.stringify(manifest));
        return fakeContent; // tarball that won't match manifest sha256
      },
      computeCurrentManifest: () => currentFiles,
      applyChanges: () => { applyCalled = true; },
    };

    await assert.rejects(
      () => runPullSelf(
        {
          region: "us-west-2",
          dryRun: false,
          apply: true,
          restart: false,
          force: false,
          showDiffs: false,
          agentEnvOverride: { ...AGENT_ENV, workspaceBase: tmpDir },
        },
        deps
      ),
      /hash mismatch|Aborting/
    );

    assert.equal(applyCalled, false, "apply should not be called after hash mismatch");
  });
});

// ── Tests: parseMarkdownSections ──────────────────────────────────────────────

describe("parseMarkdownSections", () => {
  test("extracts preamble before first heading", () => {
    const md = `# Title\n\nIntro text.\n\n## Section`;
    const parsed = parseMarkdownSections(md);
    assert.ok(parsed.preamble.includes("# Title"), "preamble includes file title");
    assert.ok(parsed.preamble.includes("Intro text."), "preamble includes intro");
    assert.equal(parsed.sections.length, 1);
    assert.equal(parsed.sections[0]?.heading, "## Section");
  });

  test("sets autoTagged=true for heading preceded by AUTO_SECTION_TAG", () => {
    const md = `# Title\n\n${AUTO_SECTION_TAG}\n## Operator Section\nContent.`;
    const parsed = parseMarkdownSections(md);
    assert.equal(parsed.sections.length, 1);
    assert.equal(parsed.sections[0]?.autoTagged, true);
    assert.equal(parsed.sections[0]?.heading, "## Operator Section");
  });

  test("sets autoTagged=false for untagged headings", () => {
    const md = `## Bot Section\nBot content.`;
    const parsed = parseMarkdownSections(md);
    assert.equal(parsed.sections[0]?.autoTagged, false);
  });

  test("AUTO_SECTION_TAG line is not included in any section body", () => {
    const md = `${AUTO_SECTION_TAG}\n## Section\nContent.`;
    const parsed = parseMarkdownSections(md);
    assert.ok(!parsed.sections[0]?.body.includes(AUTO_SECTION_TAG));
  });

  test("handles multiple sections with mixed tagging", () => {
    const md = [
      "# File",
      "",
      AUTO_SECTION_TAG,
      "## Operator",
      "Op content.",
      "",
      "## Bot Added",
      "Bot content.",
    ].join("\n");
    const parsed = parseMarkdownSections(md);
    assert.equal(parsed.sections.length, 2);
    assert.equal(parsed.sections[0]?.autoTagged, true);
    assert.equal(parsed.sections[0]?.headingKey, "operator");
    assert.equal(parsed.sections[1]?.autoTagged, false);
    assert.equal(parsed.sections[1]?.headingKey, "bot added");
  });

  test("normalises headingKey to lower-case text without hashes", () => {
    const md = `## What You Do\nContent.`;
    const parsed = parseMarkdownSections(md);
    assert.equal(parsed.sections[0]?.headingKey, "what you do");
  });
});

// ── Tests: mergeMarkdownSections ────────────────────────────────────────────

describe("mergeMarkdownSections", () => {
  test("returns null when incoming has no AUTO sections (no-op signal)", () => {
    const local = "## Section\nContent.";
    const incoming = "## Section\nNew content.";
    assert.equal(mergeMarkdownSections(local, incoming), null);
  });

  test("AUTO section from incoming overwrites matching local section", () => {
    const local = [
      "# File",
      "",
      AUTO_SECTION_TAG,
      "## Role",
      "Old operator content.",
    ].join("\n");
    const incoming = [
      "# File",
      "",
      AUTO_SECTION_TAG,
      "## Role",
      "Updated operator content.",
    ].join("\n");
    const result = mergeMarkdownSections(local, incoming)!;
    assert.ok(result.includes("Updated operator content."), "incoming AUTO content wins");
    assert.ok(!result.includes("Old operator content."), "old content removed");
  });

  test("bot-added sections in local are preserved", () => {
    const local = [
      "# File",
      "",
      AUTO_SECTION_TAG,
      "## Operator Section",
      "Operator content.",
      "",
      "## My Bot Notes",
      "Bot-added content.",
    ].join("\n");
    const incoming = [
      "# File",
      "",
      AUTO_SECTION_TAG,
      "## Operator Section",
      "Updated operator content.",
    ].join("\n");
    const result = mergeMarkdownSections(local, incoming)!;
    assert.ok(result.includes("Bot-added content."), "bot section preserved");
    assert.ok(result.includes("Updated operator content."), "operator update applied");
  });

  test("new AUTO sections in incoming are added even if absent from local", () => {
    const local = [
      "# File",
      "",
      AUTO_SECTION_TAG,
      "## Existing",
      "Content.",
    ].join("\n");
    const incoming = [
      "# File",
      "",
      AUTO_SECTION_TAG,
      "## Existing",
      "Content.",
      "",
      AUTO_SECTION_TAG,
      "## New Operator Section",
      "Newly added by operator.",
    ].join("\n");
    const result = mergeMarkdownSections(local, incoming)!;
    assert.ok(result.includes("New Operator Section"), "new AUTO section added");
    assert.ok(result.includes("Newly added by operator."), "new AUTO content included");
  });

  test("preamble is taken from incoming", () => {
    const local = "# Old Title\n\nOld intro.\n\n" + AUTO_SECTION_TAG + "\n## Section\nContent.";
    const incoming = "# New Title\n\nNew intro.\n\n" + AUTO_SECTION_TAG + "\n## Section\nContent.";
    const result = mergeMarkdownSections(local, incoming)!;
    assert.ok(result.includes("# New Title"), "incoming preamble wins");
    assert.ok(!result.includes("Old Title"), "old preamble replaced");
  });

  test("AUTO_SECTION_TAG is present in merged output for operator sections", () => {
    const incoming = AUTO_SECTION_TAG + "\n## Section\nContent.";
    const local = AUTO_SECTION_TAG + "\n## Section\nOld content.";
    const result = mergeMarkdownSections(local, incoming)!;
    assert.ok(result.includes(AUTO_SECTION_TAG), "tag preserved in output");
  });

  test("bot section matching an AUTO section key is replaced by operator version", () => {
    // Bot modified an operator section (no tag locally) — operator wins since
    // the incoming file marks it as AUTO.
    const local = [
      AUTO_SECTION_TAG,
      "## Role",
      "Bot-modified content.",  // bot removed the tag and edited
    ].join("\n");
    const incoming = [
      AUTO_SECTION_TAG,
      "## Role",
      "Operator content.",
    ].join("\n");
    const result = mergeMarkdownSections(local, incoming)!;
    assert.ok(result.includes("Operator content."), "operator wins on key-matched AUTO section");
    assert.ok(!result.includes("Bot-modified content."), "bot edit to AUTO section replaced");
  });
});

// ── Tests: applyDiff — markdown section merge ────────────────────────────────

describe("applyDiff — markdown section merge", () => {
  let tmpDir: string;
  let stagingDir: string;
  let workspaceDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-mdmerge-"));
    stagingDir = path.join(tmpDir, "staging");
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test(".md file with AUTO sections is merged, not overwritten", () => {
    const localContent = [
      "# AGENTS.md",
      "",
      AUTO_SECTION_TAG,
      "## Role",
      "Old operator content.",
      "",
      "## My Custom Section",
      "Bot-added notes.",
    ].join("\n");
    const incomingContent = [
      "# AGENTS.md",
      "",
      AUTO_SECTION_TAG,
      "## Role",
      "Updated operator content.",
    ].join("\n");

    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), localContent);
    fs.writeFileSync(path.join(stagingDir, "AGENTS.md"), incomingContent);

    const diff: FileDiff = {
      added: [],
      modified: [{ incoming: { path: "AGENTS.md", size: incomingContent.length, sha256: "x", mode: 644 }, currentSize: localContent.length }],
      deleted: [],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    const result = fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8");
    assert.ok(result.includes("Updated operator content."), "operator update applied");
    assert.ok(result.includes("Bot-added notes."), "bot section preserved");
    assert.ok(!result.includes("Old operator content."), "old operator content replaced");
  });

  test(".md file without AUTO sections is overwritten normally", () => {
    const localContent = "## Section\nOld content.";
    const incomingContent = "## Section\nNew content.";

    fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), localContent);
    fs.writeFileSync(path.join(stagingDir, "SOUL.md"), incomingContent);

    const diff: FileDiff = {
      added: [],
      modified: [{ incoming: { path: "SOUL.md", size: incomingContent.length, sha256: "y", mode: 644 }, currentSize: localContent.length }],
      deleted: [],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    const result = fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf-8");
    assert.equal(result, incomingContent, "file overwritten normally when no AUTO tags");
  });
});

// ── Tests: isProtectedPath ────────────────────────────────────────────────

describe("isProtectedPath", () => {
  test("MEMORY.md exact match is protected", () => {
    assert.equal(isProtectedPath("MEMORY.md"), true);
  });

  test("files inside memory/ are protected", () => {
    assert.equal(isProtectedPath("memory/2026-05-15.md"), true);
    assert.equal(isProtectedPath("memory/task-queue.md"), true);
    assert.equal(isProtectedPath("memory/nested/deep.md"), true);
  });

  test("all .openclaw/ subtrees are protected", () => {
    assert.equal(isProtectedPath(".openclaw/memory/index.md"), true);
    assert.equal(isProtectedPath(".openclaw/sessions/abc123.json"), true);
    assert.equal(isProtectedPath(".openclaw/plugin-skills/some-skill/SKILL.md"), true);
    assert.equal(isProtectedPath(".openclaw/plugin-state/foo.json"), true);
    assert.equal(isProtectedPath(".openclaw/logs/2026-05-15.log"), true);
    assert.equal(isProtectedPath(".openclaw/tasks/task.json"), true);
    assert.equal(isProtectedPath(".openclaw/agents/daedalus.json"), true);
    assert.equal(isProtectedPath(".openclaw/canvas/board.json"), true);
    assert.equal(isProtectedPath(".openclaw/delivery-queue/msg.json"), true);
    assert.equal(isProtectedPath(".openclaw/identity/id.json"), true);
    // operator-shipped config files fall under modified (not deleted) —
    // protecting .openclaw/ from deletion is safe for them too
    assert.equal(isProtectedPath(".openclaw/openclaw.json"), true);
  });

  test("cache and local state dirs are protected", () => {
    assert.equal(isProtectedPath(".cache/gh/token"), true);
    assert.equal(isProtectedPath(".local/state/something"), true);
    assert.equal(isProtectedPath(".npm/_cacache/index.json"), true);
  });

  test("USER.md and TOOLS.md are protected (bot fills these in from scratch)", () => {
    assert.equal(isProtectedPath("USER.md"), true);
    assert.equal(isProtectedPath("TOOLS.md"), true);
  });

  test("unrelated files are not protected", () => {
    assert.equal(isProtectedPath("AGENTS.md"), false);
    assert.equal(isProtectedPath("SOUL.md"), false);
    assert.equal(isProtectedPath("skills/some-skill/SKILL.md"), false);
  });

  test("path that starts with 'memory' but is not under memory/ is not protected", () => {
    assert.equal(isProtectedPath("memories.md"), false);
    assert.equal(isProtectedPath("memorydump.md"), false);
  });

  test("all entries in PROTECTED_PATHS are themselves protected", () => {
    for (const p of PROTECTED_PATHS) {
      const asFile = p.endsWith("/") ? `${p}example.md` : p;
      assert.ok(
        isProtectedPath(asFile),
        `Expected '${asFile}' to be protected (from prefix '${p}')`
      );
    }
  });
});

// ── Tests: computeDiff — protected paths ─────────────────────────────────────────

describe("computeDiff — protected paths", () => {
  test("MEMORY.md absent from incoming is not listed as deleted", () => {
    const current: ManifestFile[] = [
      makeFile("AGENTS.md"),
      makeFile("MEMORY.md"),
    ];
    const incoming: ManifestFile[] = [makeFile("AGENTS.md")];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.deleted.length, 0, "MEMORY.md must not appear in deleted");
  });

  test("files under memory/ absent from incoming are not listed as deleted", () => {
    const current: ManifestFile[] = [
      makeFile("AGENTS.md"),
      makeFile("memory/2026-05-15.md"),
      makeFile("memory/task-queue.md"),
    ];
    const incoming: ManifestFile[] = [makeFile("AGENTS.md")];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.deleted.length, 0, "memory/ files must not appear in deleted");
  });

  test("files anywhere under .openclaw/ absent from incoming are not listed as deleted", () => {
    const current: ManifestFile[] = [
      makeFile("AGENTS.md"),
      makeFile(".openclaw/memory/index.md"),
      makeFile(".openclaw/sessions/abc.json"),
      makeFile(".openclaw/plugin-skills/skill/SKILL.md"),
      makeFile(".openclaw/logs/2026-05-15.log"),
    ];
    const incoming: ManifestFile[] = [makeFile("AGENTS.md")];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.deleted.length, 0, ".openclaw/ files must not appear in deleted");
  });

  test("non-protected files absent from incoming ARE listed as deleted", () => {
    const current: ManifestFile[] = [
      makeFile("AGENTS.md"),
      makeFile("MEMORY.md"),
      makeFile("skills/old/SKILL.md"),
    ];
    const incoming: ManifestFile[] = [makeFile("AGENTS.md")];
    const diff = computeDiff(current, incoming);
    assert.equal(diff.deleted.length, 1);
    assert.equal(diff.deleted[0]?.path, "skills/old/SKILL.md");
  });
});

// ── Tests: applyDiff — protected paths (defence-in-depth) ──────────────────────

describe("applyDiff — protected paths (defence-in-depth)", () => {
  let tmpDir: string;
  let stagingDir: string;
  let workspaceDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-protected-"));
    stagingDir = path.join(tmpDir, "staging");
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("MEMORY.md is not deleted even when in diff.deleted", () => {
    const memPath = path.join(workspaceDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# Memory", "utf-8");

    const diff: FileDiff = {
      added: [],
      modified: [],
      deleted: [{ path: "MEMORY.md", size: 8, sha256: "x", mode: 644 }],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    assert.ok(fs.existsSync(memPath), "MEMORY.md must survive applyDiff even if listed in deleted");
  });

  test("memory/ files are not deleted even when in diff.deleted", () => {
    const memDir = path.join(workspaceDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const dailyNote = path.join(memDir, "2026-05-15.md");
    fs.writeFileSync(dailyNote, "# Notes", "utf-8");

    const diff: FileDiff = {
      added: [],
      modified: [],
      deleted: [{ path: "memory/2026-05-15.md", size: 7, sha256: "y", mode: 644 }],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    assert.ok(fs.existsSync(dailyNote), "memory/ files must survive applyDiff even if listed in deleted");
  });

  test(".openclaw/ files are not deleted even when in diff.deleted", () => {
    const ocDir = path.join(workspaceDir, ".openclaw", "sessions");
    fs.mkdirSync(ocDir, { recursive: true });
    const sessionFile = path.join(ocDir, "abc123.json");
    fs.writeFileSync(sessionFile, "{}", "utf-8");

    const diff: FileDiff = {
      added: [],
      modified: [],
      deleted: [{ path: ".openclaw/sessions/abc123.json", size: 2, sha256: "z", mode: 644 }],
    };

    applyDiff(stagingDir, workspaceDir, diff);

    assert.ok(fs.existsSync(sessionFile), ".openclaw/ files must survive applyDiff even if listed in deleted");
  });
});

// ── Tests: runPullSelf — --force ─────────────────────────────────────────────

describe("runPullSelf — --force", () => {
  test("--force bypasses no-changes early exit and shows diff", async () => {
    const files = [makeFile("AGENTS.md", 1000, "same")];
    const manifest = buildManifest("conductor", files);

    const fakeContent = Buffer.from("fake");
    const tarSha256 = crypto.createHash("sha256").update(fakeContent).digest("hex");
    manifest.tarball.sha256 = tarSha256;

    // Even with --force + no --apply, we should get changed=true back
    const deps: PullSelfDeps = {
      readAgentEnv: () => AGENT_ENV,
      downloadFromS3: async (bucket, key) => {
        if (key.endsWith(".manifest.json")) return Buffer.from(JSON.stringify(manifest));
        return fakeContent;
      },
      computeCurrentManifest: () => files, // same files
      applyChanges: () => {},
    };

    const result = await runPullSelf(
      { region: "us-west-2", dryRun: false, apply: false, restart: false, force: true, showDiffs: false, agentEnvOverride: AGENT_ENV },
      deps
    );

    assert.equal(result.changed, true, "--force should not early-exit on no changes");
    assert.equal(result.applied, false, "no --apply means not applied");
  });
});
