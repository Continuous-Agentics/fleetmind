/**
 * Structural test: every markdown link from a bundled skill's SKILL.md (or one
 * of its references/*.md files) to a references/*.md file must resolve to a
 * real file on disk.
 *
 * This guards the "trim always-loaded skill bodies, move detail into
 * references/" refactor pattern used by bot-delegation and bot-reception:
 * it's easy to rename or delete a reference file and leave a dangling pointer
 * (in prose or in a heading name) that nobody notices until an agent tries to
 * follow it mid-incident.
 *
 * Deliberately lightweight: markdown link syntax only, no full markdown AST.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fleetmindPackageRoot } from "../runtime/resolver.js";

/** Matches inline markdown links whose target is a references/*.md path. */
const REFERENCES_LINK_RE = /\]\((references\/[^)\s#]+\.md)(#[^)]*)?\)/g;

interface FoundLink {
  /** File the link was found in (relative to skill dir), for error messages. */
  sourceFile: string;
  /** The references/*.md path as written in the link. */
  target: string;
}

function findReferenceLinks(filePath: string, skillDir: string): FoundLink[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const sourceFile = path.relative(skillDir, filePath);
  const found: FoundLink[] = [];
  for (const match of content.matchAll(REFERENCES_LINK_RE)) {
    found.push({ sourceFile, target: match[1] });
  }
  return found;
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dir, f));
}

describe("bundled skill references/*.md links resolve", () => {
  const root = fleetmindPackageRoot();
  const skillsDir = path.join(root, "openclaw", "skills");
  const skillNames = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  assert.ok(skillNames.length > 0, `expected at least one bundled skill under ${skillsDir}`);

  for (const skillName of skillNames) {
    test(`${skillName}: every references/*.md link resolves to a file`, () => {
      const skillDir = path.join(skillsDir, skillName);
      const skillMd = path.join(skillDir, "SKILL.md");
      assert.ok(fs.existsSync(skillMd), `${skillName} must have a SKILL.md`);

      const filesToScan = [skillMd, ...listMarkdownFiles(path.join(skillDir, "references"))];

      const allLinks = filesToScan.flatMap((f) => findReferenceLinks(f, skillDir));

      const broken = allLinks.filter(
        (link) => !fs.existsSync(path.join(skillDir, link.target))
      );

      assert.equal(
        broken.length,
        0,
        `${skillName} has dangling references/*.md link(s):\n` +
          broken.map((b) => `  - ${b.sourceFile} -> ${b.target}`).join("\n")
      );
    });

  }
});
