/**
 * Structural test: enforces the "trim always-loaded skill bodies" contract
 * for every bundled fleetmind skill.
 *
 * Two hard rules, enforced in CI so a future edit can't silently regress
 * the bundled-skill-trim refactor:
 *
 *   1. Every SKILL.md is <=130 lines. SKILL.md is loaded on every turn the
 *      skill is active; detail belongs in references/ (procedures) or
 *      assets/ (copy-pasteable templates), linked from SKILL.md.
 *   2. No SKILL.md (or references/*.md / assets/*.md file) contains an
 *      inline `## Changelog` section, and no file instructs maintaining one.
 *      Skill history lives in git log and the repo-level CHANGELOG.md, not
 *      duplicated per-skill prose that goes stale.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fleetmindPackageRoot } from "../runtime/resolver.js";

const MAX_SKILL_MD_LINES = 130;

/** Matches an inline `## Changelog` (or `# Changelog`) heading. */
const CHANGELOG_HEADING_RE = /^#{1,6}\s*changelog\b/im;

/** Matches prose instructing the reader to add/maintain a changelog entry. */
const CHANGELOG_MAINTENANCE_RE = /\b(add|bump|maintain|update)[^.\n]{0,40}\bchangelog\b/i;

function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  // Trailing newline shouldn't count as an extra line.
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dir, f));
}

describe("bundled skill structure (line budget + no inline changelog)", () => {
  const root = fleetmindPackageRoot();
  const skillsDir = path.join(root, "openclaw", "skills");
  const skillNames = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  assert.ok(skillNames.length > 0, `expected at least one bundled skill under ${skillsDir}`);

  for (const skillName of skillNames) {
    const skillDir = path.join(skillsDir, skillName);
    const skillMd = path.join(skillDir, "SKILL.md");

    test(`${skillName}: SKILL.md is <=${MAX_SKILL_MD_LINES} lines`, () => {
      assert.ok(fs.existsSync(skillMd), `${skillName} must have a SKILL.md`);
      const lines = countLines(skillMd);
      assert.ok(
        lines <= MAX_SKILL_MD_LINES,
        `${skillName}/SKILL.md is ${lines} lines (max ${MAX_SKILL_MD_LINES}). ` +
          `Move detail to references/ (procedures) or assets/ (templates) and link it.`
      );
    });

    test(`${skillName}: no inline "## Changelog" section or changelog-maintenance instruction`, () => {
      const filesToScan = [
        skillMd,
        ...listMarkdownFiles(path.join(skillDir, "references")),
        ...listMarkdownFiles(path.join(skillDir, "assets")),
      ].filter((f) => fs.existsSync(f));

      const offenders: string[] = [];
      for (const file of filesToScan) {
        const content = fs.readFileSync(file, "utf-8");
        const rel = path.relative(skillDir, file);
        if (CHANGELOG_HEADING_RE.test(content)) {
          offenders.push(`${rel}: contains an inline "## Changelog" heading`);
        }
        if (CHANGELOG_MAINTENANCE_RE.test(content)) {
          offenders.push(`${rel}: instructs maintaining a changelog entry`);
        }
      }

      assert.equal(
        offenders.length,
        0,
        `${skillName} has changelog-related content that must be removed ` +
          `(skill history lives in git log / repo CHANGELOG.md, not per-skill prose):\n` +
          offenders.map((o) => `  - ${o}`).join("\n")
      );
    });
  }
});

// Exercise shipped policy through the real workspace generator and bundled
// skill installer. No live workspace, external registry or service is involved.
import os from "node:os";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { provisionAgent } from "../runtime/provisioner.js";
import { computeConfiguredFleetSkillGaps } from "../runtime/skills-manifest.js";

describe("canonical execution policy in generated workspaces", () => {
  for (const enabled of [false, true]) {
    for (const role of ["pm", "worker", "backend-worker", "frontend-worker"] as const) {
      test(`${role}: delegation=${enabled} preserves direct/native/fleet ownership`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-policy-"));
        try {
          const fleet = normalizeFleet(FleetSchema.parse({
            fleet: { name: "policy" },
            targets: { box: { provider: "local", os: "linux" } },
            agents: { defaults: { target: "box" }, list: [{ id: "author", name: "Author", role, skills: [] }] },
            delegation: { enabled, ...(enabled ? { table_name: "fixture-tasks", s3_bucket: "fixture-narratives" } : {}) },
          }));
          const agent = fleet.agents.list[0];
          // Only bundled protocol assets are under test; preserve external role
          // requirements in the manifest resolver without installing them here.
          agent.skills.push(...computeConfiguredFleetSkillGaps(fleet)[0].missing.filter((skill) => skill.source === "fleetmind"));
          await provisionAgent(fleet, agent, false, directory);
          const workspace = path.join(directory, "rendered/workspaces/author");
          const policy = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
          const soul = fs.readFileSync(path.join(workspace, "SOUL.md"), "utf8");
          assert.doesNotMatch(soul, /NEVER write code|You don't write the\s+code|You don't do the work/);
          assert.doesNotMatch(soul, /active-delegations\.md` as the source of truth/);
          assert.match(policy, /Direct work/);
          assert.match(policy, /focused coding/);
          assert.match(policy, /Same-Gateway native children/);
          assert.match(policy, /report privately to the parent/);
          assert.match(policy, /parent owns user-facing closeout/);
          assert.match(policy, /Independent fleet workers/);
          assert.match(policy, new RegExp(`Fleet delegation is \\*\\*${enabled ? "enabled" : "disabled"}\\*\\*`));
          assert.doesNotMatch(policy, /NEVER write code|You do not write code|NO_REPLY|Sub-agent posts the review request/);
          assert.ok(!policy.includes("{{"), "all generated policy placeholders resolve");
          assert.equal(fs.existsSync(path.join(workspace, "skills/bot-delegation")), enabled && role === "pm");
          assert.equal(fs.existsSync(path.join(workspace, "skills/worker-self-start")), enabled);
          if (enabled) {
            for (const skill of agent.skills) {
              const canonical = path.join(fleetmindPackageRoot(), "openclaw/skills", skill.name, "SKILL.md");
              assert.equal(fs.readFileSync(path.join(workspace, "skills", skill.name, "SKILL.md"), "utf8"), fs.readFileSync(canonical, "utf8"));
            }
          }
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
      });
    }
  }
});

describe("delegation policy references do not reintroduce retired mandates", () => {
  for (const name of ["bot-delegation", "worker-self-start", "bot-reception"]) {
    const directory = path.join(fleetmindPackageRoot(), "openclaw/skills", name);
    for (const file of [path.join(directory, "SKILL.md"), ...listMarkdownFiles(path.join(directory, "references")), ...listMarkdownFiles(path.join(directory, "assets"))]) {
      test(`${name}/${path.relative(directory, file)}: no mandatory subscriber or public child closeout`, () => {
        const content = fs.readFileSync(file, "utf8");
        assert.doesNotMatch(content, /NO_REPLY|subscriber startup \(mandatory\)|Start the NATS subscriber \(mandatory\)|ensure the NATS (?:PM )?subscriber is running|Never write code|Orchestrate only|Then update audit log to done|Signed off — closing\./i);
      });
    }
  }
});
