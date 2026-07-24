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
