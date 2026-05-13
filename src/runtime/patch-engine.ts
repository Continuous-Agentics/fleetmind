/**
 * Workspace patch engine — applies idempotent named patches to workspace .md files.
 *
 * Patches are defined in PATCHES.md files shipped with each role template.
 * Each patch is applied once; re-runs are safe (idempotent via detect strings).
 *
 * Format:
 *   ## Patch: <name>
 *   - **id:** `unique-slug`
 *   - **file:** AGENTS.md
 *   - **detect:** `string — if found in file, patch already applied`
 *   - **after:** `heading text to insert after` | `end-of-file`
 *   - **mode:** insert-after | append-file | replace-section  (default: insert-after)
 *   - **added:** YYYY-MM-DD
 *   - **deprecated:** YYYY-MM-DD  (optional — no-op when set)
 *   - **roles:** all | pm | worker  (optional — default: all)
 *   - **description:** what this patch does
 *
 *   ```markdown
 *   ... content to insert ...
 *   ```
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PatchMode = "insert-after" | "append-file" | "replace-section";

export interface WorkspacePatch {
  name: string;
  id: string;
  file: string;
  detect: string;
  after: string;
  mode: PatchMode;
  added: string;
  deprecated?: string;
  roles?: string[];
  description?: string;
  content: string;
}

export interface PatchResult {
  id: string;
  file: string;
  status: "applied" | "skipped" | "deprecated" | "missing-file" | "anchor-not-found";
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a PATCHES.md file into an array of WorkspacePatch objects.
 */
export function parsePatches(patchesContent: string): WorkspacePatch[] {
  const patches: WorkspacePatch[] = [];

  // Split on patch headings (## Patch: <name> or ## Patch: <name> (DEPRECATED))
  const sections = patchesContent.split(/\n(?=## Patch:)/);

  for (const section of sections) {
    if (!section.trim().startsWith("## Patch:")) continue;

    const nameMatch = section.match(/^## Patch:\s*(.+)$/m);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const field = (key: string): string | undefined => {
      const m = section.match(new RegExp(`^-\\s+\\*\\*${key}:\\*\\*\\s+\`?([^\`\\n]+)\`?`, "m"));
      return m?.[1]?.trim();
    };

    const id = field("id");
    const file = field("file");
    const detect = field("detect");
    const after = field("after") ?? "end-of-file";
    const mode = (field("mode") ?? "insert-after") as PatchMode;
    const added = field("added") ?? "";
    const deprecated = field("deprecated");
    const rolesRaw = field("roles");
    const description = field("description");

    if (!id || !file || !detect) continue;

    const roles = rolesRaw
      ? rolesRaw.split(",").map((r) => r.trim())
      : ["all"];

    // Extract fenced code block content
    const contentMatch = section.match(/```(?:markdown)?\n([\s\S]*?)```/);
    const content = contentMatch?.[1] ?? "";

    patches.push({
      name,
      id,
      file,
      detect,
      after,
      mode,
      added,
      deprecated,
      roles,
      description,
      content,
    });
  }

  return patches;
}

// ── Patch application ─────────────────────────────────────────────────────────

function insertAfterHeading(
  fileContent: string,
  afterHeading: string,
  content: string
): string | null {
  if (afterHeading === "end-of-file") {
    return fileContent.trimEnd() + "\n\n" + content.trimEnd() + "\n";
  }

  // Find the heading line (## <afterHeading> or similar)
  const lines = fileContent.split("\n");
  let insertIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(afterHeading)) {
      // Insert after this heading — skip over any immediately following
      // blank line so content lands under the heading cleanly
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      insertIdx = j;
      break;
    }
  }

  if (insertIdx === -1) return null;

  lines.splice(insertIdx, 0, content.trimEnd(), "");
  return lines.join("\n");
}

function replaceSection(
  fileContent: string,
  startMarker: string,
  endMarker: string,
  newContent: string
): string | null {
  const startIdx = fileContent.indexOf(startMarker);
  const endIdx = fileContent.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return null;
  return (
    fileContent.slice(0, startIdx) +
    startMarker + "\n" + newContent.trimEnd() + "\n" + endMarker +
    fileContent.slice(endIdx + endMarker.length)
  );
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Apply all patches from a PATCHES.md file against the workspace directory.
 * Patches are idempotent — already-applied patches are silently skipped.
 *
 * @param patchesPath  Path to the PATCHES.md file
 * @param workspaceDir Path to the agent's live workspace directory
 * @param role         Agent role (e.g. "pm", "worker") for role filtering
 */
export function applyWorkspacePatches(
  patchesPath: string,
  workspaceDir: string,
  role?: string
): PatchResult[] {
  if (!fs.existsSync(patchesPath)) return [];

  const patchesContent = fs.readFileSync(patchesPath, "utf-8");
  const patches = parsePatches(patchesContent);
  const results: PatchResult[] = [];

  for (const patch of patches) {
    // Skip deprecated patches
    if (patch.deprecated) {
      results.push({ id: patch.id, file: patch.file, status: "deprecated" });
      continue;
    }

    // Role filter
    if (role && !patch.roles?.includes("all") && !patch.roles?.includes(role)) {
      results.push({ id: patch.id, file: patch.file, status: "skipped" });
      continue;
    }

    const filePath = path.join(workspaceDir, patch.file);

    // Missing target file — skip (file may not exist for this agent)
    if (!fs.existsSync(filePath)) {
      results.push({ id: patch.id, file: patch.file, status: "missing-file" });
      continue;
    }

    let fileContent = fs.readFileSync(filePath, "utf-8");

    // Already applied — detect string or patch marker present
    const patchMarker = `<!-- fleetmind:patch:${patch.id} -->`;
    if (fileContent.includes(patch.detect) || fileContent.includes(patchMarker)) {
      results.push({ id: patch.id, file: patch.file, status: "skipped" });
      continue;
    }

    // Apply patch
    let updated: string | null = null;

    if (patch.mode === "append-file") {
      updated = fileContent.trimEnd() + "\n\n" + patch.content.trimEnd() + "\n";
    } else if (patch.mode === "replace-section") {
      const startMarker = `<!-- fleetmind:section:${patch.id}:start -->`;
      const endMarker = `<!-- fleetmind:section:${patch.id}:end -->`;
      updated = replaceSection(fileContent, startMarker, endMarker, patch.content);
      if (!updated) {
        // Section markers not present — fall back to insert-after
        updated = insertAfterHeading(fileContent, patch.after, patch.content);
      }
    } else {
      // insert-after (default)
      updated = insertAfterHeading(fileContent, patch.after, patch.content);
    }

    if (updated === null) {
      log.warn(`  patch '${patch.id}': anchor '${patch.after}' not found in ${patch.file} — skipping`);
      results.push({ id: patch.id, file: patch.file, status: "anchor-not-found" });
      continue;
    }

    // Write back
    fs.writeFileSync(filePath, updated, "utf-8");
    log.info(`  patch '${patch.id}' → ${patch.file}`);
    results.push({ id: patch.id, file: patch.file, status: "applied" });
  }

  return results;
}
