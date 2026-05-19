/**
 * fleetmind pull-self — bot-side workspace update pull.
 *
 * Runs ON each bot. Fetches the latest deploy-staging tarball from S3,
 * diffs against the current workspace, and optionally applies.
 *
 * Default (no flags): show diff and exit. Use --apply to apply.
 * Use --dry-run to fetch + show diff without any local changes.
 *
 * Usage:
 *   fleetmind pull-self [--apply] [--dry-run] [--restart] [--region <r>] [--show-diffs] [--force]
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";

import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

import type { ManifestFile, DeployManifest } from "./push-fleet.js";
import { log } from "../../utils/log.js";
import { applyWorkspacePatches } from "../../runtime/patch-engine.js";

export { ManifestFile, DeployManifest };

// ── Protected paths ─────────────────────────────────────────────────────────────

/**
 * Path prefixes that pull-self must never delete, regardless of what the
 * incoming S3 manifest says.  These are agent-owned files that the operator
 * never ships — deleting them would wipe memory and runtime state.
 *
 * Rules:
 *   - An exact match protects a single file  (e.g. "MEMORY.md").
 *   - A trailing "/" protects an entire directory  (e.g. "memory/").
 *   - Matching is prefix-based: "memory/" protects "memory/2026-05-15.md".
 */
export const PROTECTED_PATHS: readonly string[] = [
  // MEMORY.md is intentionally NOT protected — the operator may push AUTO-tagged
  // sections (fleet facts, key context). The section merge preserves bot-added
  // entries. Only the memory/ daily-notes dir is fully agent-owned.
  "memory/",
  ".openclaw/",
  ".cache/",
  ".config/",
  ".local/",
  ".npm/",
  // USER.md is bot-filled during onboarding and never overwritten by the operator.
  "USER.md",
  // TOOLS.md is intentionally NOT protected — the operator may push AUTO-tagged
  // sections (e.g. ### Paths) via section merge while bot-added content is
  // preserved. Same pattern as MEMORY.md.
];

/**
 * Return true if `filePath` (relative, forward-slash) falls under any
 * protected prefix.
 */
export function isProtectedPath(filePath: string): boolean {
  for (const prefix of PROTECTED_PATHS) {
    if (prefix.endsWith("/")) {
      // Directory prefix — match the dir itself or any file inside it
      if (filePath === prefix.slice(0, -1) || filePath.startsWith(prefix)) {
        return true;
      }
    } else {
      // Exact file match
      if (filePath === prefix) return true;
    }
  }
  return false;
}

// ── Markdown section merge ──────────────────────────────────────────────────────────────

/**
 * The tag that marks a Markdown section as operator-owned.
 * Place it on the line immediately before a heading.
 * Invisible in rendered Markdown (HTML comment).
 *
 * Merge behaviour:
 *   - Sections preceded by this tag → always taken from incoming (operator wins)
 *   - Sections without the tag that exist locally → preserved (bot-added)
 *   - NEW auto-tagged sections in incoming not yet in local → appended
 *   - Preamble (everything before the first heading) → taken from incoming
 */
export const AUTO_SECTION_TAG = "<!-- AUTO SECTION -->";

export interface MarkdownSection {
  /** True when preceded by AUTO_SECTION_TAG in the source. */
  autoTagged: boolean;
  /** Full heading line, e.g. "## What You Do" */
  heading: string;
  /** Normalised key used for section matching (heading text, lower-cased). */
  headingKey: string;
  /** Lines after the heading until the next heading, joined with "\n". */
  body: string;
}

export interface ParsedMarkdown {
  /** Content before the first heading (may include the `#` title line). */
  preamble: string;
  sections: MarkdownSection[];
}

/** Normalise a heading line to a lookup key. */
function headingKey(heading: string): string {
  return heading.replace(/^#+\s+/, "").toLowerCase().trim();
}

/**
 * Parse a Markdown string into preamble + sections.
 * The AUTO_SECTION_TAG line is consumed and sets `autoTagged` on the
 * immediately following heading; it does not appear in any body.
 */
export function parseMarkdownSections(content: string): ParsedMarkdown {
  const lines = content.split("\n");
  const preambleLines: string[] = [];
  const sections: MarkdownSection[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];
  let currentAutoTagged = false;
  let pendingAutoTag = false;
  let inSection = false;

  const pushSection = (): void => {
    if (!inSection) return;
    // Trim trailing blank lines from body
    let body = currentBody.join("\n");
    body = body.replace(/\n+$/, "");
    sections.push({
      autoTagged: currentAutoTagged,
      heading: currentHeading,
      headingKey: headingKey(currentHeading),
      body,
    });
  };

  for (const line of lines) {
    const isAutoTag = line.trim() === AUTO_SECTION_TAG;
    // Only ## and deeper start a new section; # (file title) stays in preamble
    const isHeading = /^#{2,6} /.test(line);

    if (isAutoTag) {
      // Buffer the tag; it belongs to the next heading.
      // If we're inside a section, don't add the tag line to its body.
      pendingAutoTag = true;
      continue;
    }

    if (isHeading) {
      pushSection();
      inSection = true;
      currentHeading = line;
      currentAutoTagged = pendingAutoTag;
      currentBody = [];
      pendingAutoTag = false;
      continue;
    }

    // Regular line
    if (inSection) {
      currentBody.push(line);
    } else {
      // pendingAutoTag before a non-heading is unusual; treat it as preamble text
      if (pendingAutoTag) {
        preambleLines.push(AUTO_SECTION_TAG);
        pendingAutoTag = false;
      }
      preambleLines.push(line);
    }
  }

  pushSection();

  // Trim trailing blank lines from preamble
  let preamble = preambleLines.join("\n").replace(/\n+$/, "");

  return { preamble, sections };
}

/** Serialise a section back to string (with tag if auto-tagged). */
function formatSection(s: MarkdownSection): string {
  const parts: string[] = [];
  if (s.autoTagged) parts.push(AUTO_SECTION_TAG);
  parts.push(s.heading);
  if (s.body) parts.push(s.body);
  return parts.join("\n");
}

/**
 * Detect the inter-section separator used by a file so the merged output
 * uses the same spacing and does not cause sha256 drift on repeated pushes.
 *
 * Looks for blank lines between a section body and the next heading (or tag).
 * Defaults to a single blank line ("\n\n") if the pattern cannot be determined.
 */
function detectSectionSeparator(content: string): string {
  // Match: end of body content, then one or more blank lines, then a heading
  // or AUTO tag. Count the blank lines between them.
  const m = content.match(/\S(\n+)(?:<!--\s*AUTO SECTION\s*-->\n)?#{2,6} /);
  if (!m) return "\n\n";
  // m[1] is the run of newlines after the last non-whitespace body character.
  // Two newlines = one blank line; three = two blank lines, etc.
  return m[1]!.length >= 3 ? "\n\n\n" : "\n\n";
}

/**
 * Merge two Markdown files using AUTO SECTION semantics.
 *
 * Rules:
 *   1. Preamble → taken from incoming.
 *   2. AUTO-tagged sections in incoming → always overwrite/add (operator-owned).
 *   3. Untagged sections in local not matched by any incoming AUTO section
 *      → preserved at the end (bot-added).
 *
 * Separator between sections is inferred from the incoming file so the merged
 * output is byte-stable on repeated pushes (no sha256 drift).
 *
 * If incoming has zero AUTO-tagged sections the file is returned unchanged
 * (no tags = not a managed file; fall back to normal overwrite).
 *
 * Returns null when no merge was performed (caller should do normal overwrite).
 */
export function mergeMarkdownSections(
  local: string,
  incoming: string
): string | null {
  const incomingParsed = parseMarkdownSections(incoming);
  const autoSections = incomingParsed.sections.filter((s) => s.autoTagged);

  // Not a managed file — no auto tags. Signal caller to overwrite normally.
  if (autoSections.length === 0) return null;

  const localParsed = parseMarkdownSections(local);
  const sep = detectSectionSeparator(incoming);

  const parts: string[] = [];

  // Preamble from incoming (operator owns the file title and intro)
  if (incomingParsed.preamble) parts.push(incomingParsed.preamble);

  const includedKeys = new Set<string>();

  // AUTO sections from incoming — operator-owned, always current
  for (const s of autoSections) {
    parts.push(formatSection(s));
    includedKeys.add(s.headingKey);
  }

  // Bot-added sections: in local but not in any incoming AUTO section
  for (const s of localParsed.sections) {
    if (!includedKeys.has(s.headingKey)) {
      parts.push(formatSection(s));
    }
  }

  return parts.join(sep) + "\n";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentEnv {
  fleetName: string;
  agentId: string;
  workspaceBase: string;
}

export interface FileDiff {
  added: ManifestFile[];
  modified: { incoming: ManifestFile; currentSize: number }[];
  deleted: ManifestFile[];
}

// ── Dependency injection ──────────────────────────────────────────────────────

export interface PullSelfDeps {
  /** Read /etc/fleetmind/agent.env. Returns parsed values. */
  readAgentEnv?: () => AgentEnv;
  /** Download file from S3, return Buffer. */
  downloadFromS3?: (bucket: string, key: string, region: string) => Promise<Buffer>;
  /** Compute manifest of current workspace directory. */
  computeCurrentManifest?: (workspaceDir: string) => ManifestFile[];
  /** Apply a diff from stagingDir into workspaceDir. */
  applyChanges?: (stagingDir: string, workspaceDir: string, diff: FileDiff) => void;
  /** Restart the gateway systemd unit. */
  restartGateway?: (agentId: string) => void;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

const AGENT_ENV_PATH = "/etc/fleetmind/agent.env";

/** Parse /etc/fleetmind/agent.env into AgentEnv. */
export function parseAgentEnv(text: string): AgentEnv {
  const get = (key: string): string => {
    const m = text.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m?.[1]?.trim() ?? "";
  };
  const fleetName = get("FLEET_NAME");
  const agentId = get("AGENT_ID");
  const workspaceBase = get("WORKSPACE_BASE") || "/opt/openclaw/workspace";
  if (!fleetName) throw new Error(`${AGENT_ENV_PATH} is missing FLEET_NAME`);
  if (!agentId) throw new Error(`${AGENT_ENV_PATH} is missing AGENT_ID`);
  return { fleetName, agentId, workspaceBase };
}

/** Default: read /etc/fleetmind/agent.env from disk. */
export function readAgentEnvFromDisk(): AgentEnv {
  if (!fs.existsSync(AGENT_ENV_PATH)) {
    throw new Error(
      `${AGENT_ENV_PATH} not found. Is this running on a FleetMind-managed instance?\n` +
      "Set FLEET_NAME and AGENT_ID environment variables or create the file."
    );
  }
  return parseAgentEnv(fs.readFileSync(AGENT_ENV_PATH, "utf-8"));
}

/**
 * Walk a directory and compute sha256 + stat for every file.
 * Returns paths relative to baseDir, using forward-slash separators.
 */
export function computeWorkspaceManifest(workspaceDir: string): ManifestFile[] {
  const results: ManifestFile[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Use statSync (follows symlinks) to guard against symlinks that point
        // to directories — readFileSync on those throws EISDIR.
        const stat = fs.statSync(abs);
        if (!stat.isFile()) {
          if (stat.isDirectory()) walk(abs);
          continue;
        }
        const rel = path.relative(workspaceDir, abs).replace(/\\/g, "/");
        const content = fs.readFileSync(abs);
        const sha256 = crypto.createHash("sha256").update(content).digest("hex");
        const mode = parseInt((stat.mode & 0o777).toString(8), 10);
        results.push({ path: rel, size: stat.size, sha256, mode });
      }
    }
  }

  if (fs.existsSync(workspaceDir)) walk(workspaceDir);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/** Compute diff between current and incoming file manifests. */
export function computeDiff(
  currentFiles: ManifestFile[],
  incomingFiles: ManifestFile[]
): FileDiff {
  const currentMap = new Map(currentFiles.map((f) => [f.path, f]));
  const incomingMap = new Map(incomingFiles.map((f) => [f.path, f]));

  const added: ManifestFile[] = [];
  const modified: { incoming: ManifestFile; currentSize: number }[] = [];
  const deleted: ManifestFile[] = [];

  for (const incoming of incomingFiles) {
    const current = currentMap.get(incoming.path);
    if (!current) {
      added.push(incoming);
    } else if (current.sha256 !== incoming.sha256) {
      modified.push({ incoming, currentSize: current.size });
    }
  }

  for (const current of currentFiles) {
    if (!incomingMap.has(current.path)) {
      // Never surface protected paths as deletions — they are agent-owned and
      // must survive every push regardless of what the S3 manifest contains.
      if (!isProtectedPath(current.path)) {
        deleted.push(current);
      }
    }
  }

  return { added, modified, deleted };
}

/** Format bytes for human display. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Group files by their top-level directory for display. */
function groupByTopDir(files: { path: string }[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const top = f.path.includes("/") ? f.path.split("/")[0]! : "(root)";
    const arr = groups.get(top) ?? [];
    arr.push(f.path);
    groups.set(top, arr);
  }
  return groups;
}

/**
 * Detect directory removals: paths that share a top-level directory that is
 * entirely absent from the incoming manifest.
 */
function detectDeletedDirs(deleted: ManifestFile[], incoming: ManifestFile[]): Map<string, number> {
  const incomingDirs = new Set(incoming.map((f) => f.path.split("/")[0]));
  const dirCounts = new Map<string, number>();
  for (const d of deleted) {
    const top = d.path.split("/")[0]!;
    if (top !== d.path && !incomingDirs.has(top)) {
      // This file's top-level dir is not in incoming at all → dir removal
      dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
    }
  }
  return dirCounts;
}

/**
 * Format a diff for human display.
 * Returns the printed string (so callers/tests can assert on it).
 */
/**
 * Compute +added / -removed line counts between two text strings.
 * Returns "+0 -0" when content is identical or non-text.
 */
function lineDeltaLabel(current: string, incoming: string): string {
  const cur = current.split("\n");
  const inc = incoming.split("\n");
  let added = 0, removed = 0;
  const maxLen = Math.max(cur.length, inc.length);
  for (let i = 0; i < maxLen; i++) {
    if (cur[i] !== inc[i]) {
      if (cur[i] !== undefined) removed++;
      if (inc[i] !== undefined) added++;
    }
  }
  const a = added > 0 ? `+${added}` : "";
  const r = removed > 0 ? `-${removed}` : "";
  return [a, r].filter(Boolean).join(" ") || "unchanged";
}

export function formatDiff(
  agentId: string,
  diff: FileDiff,
  incomingFiles: ManifestFile[],
  workspaceDir?: string,
  stagingDir?: string
): string {
  const lines: string[] = [`Fleet update for ${agentId}:`];

  if (diff.added.length > 0) {
    lines.push("  Added:");
    for (const f of diff.added) {
      lines.push(`    ${f.path}  (${fmtBytes(f.size)})`);
    }
  }

  if (diff.modified.length > 0) {
    lines.push("  Modified:");
    for (const { incoming } of diff.modified) {
      let delta = "";
      if (workspaceDir && stagingDir) {
        try {
          const curContent = fs.readFileSync(path.join(workspaceDir, incoming.path), "utf-8");
          const incContent = fs.readFileSync(path.join(stagingDir, incoming.path), "utf-8");
          delta = "  " + lineDeltaLabel(curContent, incContent);
        } catch { /* non-text or missing — fall back to byte sizes */ }
      }
      const byteFallback = delta ? "" : `  (was ${fmtBytes(incoming.size)})`;
      lines.push(`    ${incoming.path}${delta || byteFallback}`);
    }
  }

  if (diff.deleted.length > 0) {
    const dirRemovals = detectDeletedDirs(diff.deleted, incomingFiles);
    lines.push("  Deleted:");
    for (const f of diff.deleted) {
      const top = f.path.split("/")[0]!;
      const isDir = top !== f.path && dirRemovals.has(top);
      if (isDir) {
        if (f.path === diff.deleted.find((d) => d.path.startsWith(top + "/"))?.path) {
          const count = dirRemovals.get(top)!;
          lines.push(`    ${top}/  (entire dir, ${count} file${count !== 1 ? "s" : ""})`);
        }
      } else {
        lines.push(`    ${f.path}  (${fmtBytes(f.size)})`);
      }
    }
  }

  const dirRemovals = detectDeletedDirs(diff.deleted, incomingFiles);
  const dirCount = dirRemovals.size;
  const parts: string[] = [];
  if (diff.added.length) parts.push(`${diff.added.length} added`);
  if (diff.modified.length) parts.push(`${diff.modified.length} modified`);
  if (diff.deleted.length) {
    parts.push(dirCount > 0
      ? `${diff.deleted.length} deleted (${dirCount} dir removal${dirCount !== 1 ? "s" : ""})`
      : `${diff.deleted.length} deleted`);
  }

  lines.push("");
  lines.push(`Summary: ${parts.length ? parts.join(", ") : "no changes"}.`);
  lines.push("");
  lines.push("Apply with: fleetmind pull-self --apply [--restart]");
  if (diff.modified.length > 0) {
    lines.push("Show file diffs: fleetmind pull-self --show-diffs [<file>] [--full]");
  }

  return lines.join("\n");
}

/**
 * Show per-file unified diffs for modified files.
 * @param filter  If set, only show diffs for files matching this substring/glob.
 * @param full    If true, show the entire diff without line cap.
 */
export function showFileDiffs(
  stagingDir: string,
  workspaceDir: string,
  modified: { incoming: ManifestFile; currentSize: number }[],
  filter?: string,
  full?: boolean
): void {
  const MAX_LINES_PER_FILE = 200;

  const targets = filter
    ? modified.filter(({ incoming }) =>
        incoming.path.includes(filter) ||
        incoming.path.endsWith(filter)
      )
    : modified;

  if (targets.length === 0) {
    log.dim(filter ? `  no modified files matching '${filter}'` : "  no modified files");
    return;
  }

  for (const { incoming } of targets) {
    const currentPath = path.join(workspaceDir, incoming.path);
    const stagingPath = path.join(stagingDir, incoming.path);
    if (!fs.existsSync(currentPath) || !fs.existsSync(stagingPath)) continue;

    try {
      const currentContent = fs.readFileSync(currentPath, "utf-8");
      const stagingContent = fs.readFileSync(stagingPath, "utf-8");
      if (currentContent === stagingContent) continue;

      log.info(`\n\x1b[33m--- ${incoming.path} (current)\x1b[0m`);
      log.info(`\x1b[33m+++ ${incoming.path} (incoming)\x1b[0m`);

      const currentLines = currentContent.split("\n");
      const stagingLines = stagingContent.split("\n");
      const maxLen = Math.max(currentLines.length, stagingLines.length);
      const cap = full ? Infinity : MAX_LINES_PER_FILE;
      let shown = 0;

      for (let i = 0; i < maxLen && shown < cap; i++) {
        const c = currentLines[i];
        const s = stagingLines[i];
        if (c !== s) {
          if (c !== undefined) { log.info(`\x1b[31m- ${c}\x1b[0m`); shown++; }
          if (s !== undefined) { log.info(`\x1b[32m+ ${s}\x1b[0m`); shown++; }
        }
      }
      if (shown >= cap) {
        log.dim(`  … diff truncated at ${cap} lines. Re-run with --full to see everything.`);
      }
    } catch {
      log.dim(`  ${incoming.path}: (binary or unreadable — skipping)`);
    }
  }
}

/**
 * Verify tarball sha256 matches the manifest. Throws on mismatch.
 */
export function verifyTarball(tarballPath: string, expectedSha256: string): void {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `Tarball hash mismatch for ${path.basename(tarballPath)}:\n` +
      `  expected: ${expectedSha256}\n` +
      `  actual:   ${actual}\n` +
      "Aborting apply — the upload may be incomplete or corrupted."
    );
  }
}

/**
 * Deep-merge two plain objects. Values from `overrides` win over `base`.
 * Arrays are replaced (not concatenated).
 */
function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof base[key] === 'object' &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(
        base[key] as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Compute a partial object containing only keys that differ between base and live.
 */
function diffObjects(
  base: Record<string, unknown>,
  live: Record<string, unknown>
): Record<string, unknown> {
  const patches: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(live)])) {
    if (JSON.stringify(base[key]) !== JSON.stringify(live[key])) {
      patches[key] = live[key];
    }
  }
  return patches;
}

/**
 * Three-way merge for openclaw.json:
 *   result = deepMerge(incoming, live − base)
 *
 * incoming = new rendered config from tarball
 * live     = current on-disk config (may have operator patches)
 * base     = what fleetmind last rendered (.openclaw/openclaw.base.json)
 *
 * Operator patches (live keys that differ from base) are preserved on top
 * of the incoming rendered config. If no base exists (first push), incoming
 * wins entirely. Returns merged config with transient _patched=true when
 * patches were applied.
 */
export function mergeOpenClawConfig(
  incomingPath: string,
  livePath: string,
  workspaceDir: string
): Record<string, unknown> {
  const incoming = JSON.parse(fs.readFileSync(incomingPath, 'utf-8')) as Record<string, unknown>;

  const basePath = path.join(workspaceDir, '.openclaw', 'openclaw.base.json');
  if (!fs.existsSync(basePath) || !fs.existsSync(livePath)) {
    return incoming;
  }

  const base = JSON.parse(fs.readFileSync(basePath, 'utf-8')) as Record<string, unknown>;
  const live = JSON.parse(fs.readFileSync(livePath, 'utf-8')) as Record<string, unknown>;

  const patches = diffObjects(base, live);

  // Always restore incoming.agents.list regardless of whether patches exist.
  // agents.list is fleet-managed (derived from fleet.yaml by the renderer)
  // and is never directly operator-patched via 'openclaw config patch'.
  // The (live − base) diff can produce patches.agents when the live config
  // is missing a renderer-added field (e.g. workspace, agentDir).
  // deepMerge replaces arrays wholesale, so without this guard the stale
  // live.agents.list (no workspace) would silently win over incoming.
  //
  // Concrete failure mode:
  //   base  = { agents: { list: [{ id, name, workspace, ... }] } }  (rendered w/ workspace)
  //   live  = { agents: { list: [{ id, name, ... }] } }             (old file, no workspace)
  //   patches.agents = live.agents  (because JSON(base.agents) ≠ JSON(live.agents))
  //   deepMerge replaces incoming.agents.list with live.agents.list  → workspace lost
  const hasIncomingList =
    incoming.agents !== undefined &&
    typeof incoming.agents === 'object' &&
    !Array.isArray(incoming.agents) &&
    Array.isArray((incoming.agents as Record<string, unknown>).list);

  if (Object.keys(patches).length === 0) {
    return incoming;
  }

  const merged = deepMerge(incoming, patches);

  if (
    hasIncomingList &&
    merged.agents !== undefined &&
    typeof merged.agents === 'object' &&
    !Array.isArray(merged.agents)
  ) {
    const incomingAgents = incoming.agents as Record<string, unknown>;
    const mergedAgents = merged.agents as Record<string, unknown>;
    mergedAgents.list = incomingAgents.list;
  }

  // Only mark _patched when keys OTHER than agents are patched, OR when
  // agents has keys other than list patched. agents.list is always taken
  // from incoming (fleet-managed), so an agents-only patch that only affects
  // list is not a meaningful operator customisation to surface.
  const nonAgentsPatched = Object.keys(patches).some((k) => k !== 'agents');
  const agentsNonListPatched = (() => {
    if (!('agents' in patches) || typeof patches.agents !== 'object' || Array.isArray(patches.agents) || patches.agents === null) return false;
    const pAgents = patches.agents as Record<string, unknown>;
    return Object.keys(pAgents).some((k) => k !== 'list');
  })();

  if (nonAgentsPatched || agentsNonListPatched) {
    (merged as Record<string, unknown>)._patched = true;
  }
  return merged;
}

/**
 * Apply diff: copy added/modified from staging to workspace.
 * Uses atomic .new → rename for modified files.
 *
 * Deletions are intentionally skipped — pull-self only manages files
 * it shipped. The runtime creates many files alongside fleetmind's
 * (memory, sessions, plugin-skills, cron state, etc.) and deleting
 * anything not in the incoming tarball would wipe agent state.
 *
 * Additionally, any path that matches PROTECTED_PATHS is filtered out of
 * the deleted list by computeDiff before it ever reaches here, and is also
 * skipped in the modified loop — providing an explicit, named safety net
 * that survives future changes to deletion or update behaviour.
 */
export function applyDiff(
  stagingDir: string,
  workspaceDir: string,
  diff: FileDiff
): void {
  // Defensive guard: even if a protected path slips past computeDiff (e.g.
  // direct applyDiff call in tests or future refactors), never delete it.
  const safeDeleted = diff.deleted.filter((f) => {
    if (isProtectedPath(f.path)) {
      log.dim(`  ⚠ protected: ${f.path} (skipped — agent-owned, never deleted)`);
      return false;
    }
    return true;
  });
  const safeDiff: FileDiff = { ...diff, deleted: safeDeleted };
  // Apply added files
  for (const f of safeDiff.added) {
    const src = path.join(stagingDir, f.path);
    const dest = path.join(workspaceDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    log.info(`  + ${f.path}`);
  }

  // Apply modified files — atomic rename for all except .openclaw/openclaw.json
  for (const { incoming } of safeDiff.modified) {
    const src = path.join(stagingDir, incoming.path);
    const dest = path.join(workspaceDir, incoming.path);

    // openclaw.json is operator-shipped (rendered by fleetmind). It MUST be
    // updated on every push via three-way merge so workspace/agentDir and
    // other renderer-managed fields stay current. Handle it BEFORE the
    // protected-path check: .openclaw/ is protected to guard agent-owned
    // runtime state (sessions, plugin state, cron) but NOT the two operator-
    // shipped files that live there.
    if (incoming.path === ".openclaw/openclaw.json") {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Three-way merge: incoming (rendered) + (live - base) = merged.
      // Operator patches applied via 'openclaw config patch' survive pushes.
      const merged = mergeOpenClawConfig(src, dest, workspaceDir);
      if (merged._patched) {
        log.dim(`    ℹ live config patches preserved (see .openclaw/openclaw.base.json for base)`);
        delete (merged as Record<string, unknown>)._patched;
      }
      fs.writeFileSync(dest, JSON.stringify(merged, null, 2));
      log.info(`  ~ ${incoming.path}`);
      continue;
    }

    // openclaw.base.json is the render snapshot used as the three-way-merge
    // baseline. Always update it so the next push has an accurate baseline.
    // Also exempt from the protected-path check for the same reason.
    if (incoming.path === ".openclaw/openclaw.base.json") {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.new`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
      log.info(`  ~ ${incoming.path}`);
      continue;
    }

    // Defence-in-depth: skip protected paths in modified too.
    // Normally a protected file wouldn't appear here (operator doesn't ship
    // agent-owned files), but guard in case they do.
    if (isProtectedPath(incoming.path)) {
      log.dim(`  ⚠ protected: ${incoming.path} (skipped — agent-owned, never modified)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (incoming.path.endsWith(".md") && fs.existsSync(dest)) {
      // Section merge for Markdown files: AUTO-tagged sections from incoming
      // overwrite local; untagged local sections (bot-added) are preserved.
      const localContent = fs.readFileSync(dest, "utf-8");
      const incomingContent = fs.readFileSync(src, "utf-8");
      const merged = mergeMarkdownSections(localContent, incomingContent);
      if (merged !== null) {
        fs.writeFileSync(dest, merged, "utf-8");
        log.dim(`    ℹ sections merged (bot additions preserved)`);
      } else {
        // No AUTO tags — not a managed file; overwrite normally
        const tmp = `${dest}.new`;
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dest);
      }
    } else {
      const tmp = `${dest}.new`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
    }
    log.info(`  ~ ${incoming.path}`);
  }

  // Deletions are skipped — see function comment above.
}

/** Remove a directory if it's empty, up to (but not including) stopAt. */
function tryRemoveEmptyDir(dir: string, stopAt: string): void {
  if (dir === stopAt || !dir.startsWith(stopAt)) return;
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
      tryRemoveEmptyDir(path.dirname(dir), stopAt);
    }
  } catch { /* ignore */ }
}

// ── Default production implementations ───────────────────────────────────────

async function defaultDownloadFromS3(
  bucket: string,
  key: string,
  region: string
): Promise<Buffer> {
  const s3 = new S3Client({ region });
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) throw new Error(`Empty body from S3: s3://${bucket}/${key}`);

  const chunks: Buffer[] = [];
  const stream = resp.Body as NodeJS.ReadableStream;
  for await (const chunk of stream) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
  }
  return Buffer.concat(chunks);
}

function defaultRestartGateway(agentId: string): void {
  execFileSync("sudo", ["systemctl", "restart", `openclaw-${agentId}`], { stdio: "inherit" });
}

// ── Core logic ────────────────────────────────────────────────────────────────

export interface PullSelfOptions {
  region: string;
  dryRun: boolean;
  apply: boolean;
  restart: boolean;
  force: boolean;
  showDiffs: boolean;
  showDiffsFilter?: string;
  showDiffsFull?: boolean;
  /** Override agent env (for testing). */
  agentEnvOverride?: AgentEnv;
}

/**
 * Main pull-self logic. Injectable deps for testing.
 */
export async function runPullSelf(
  opts: PullSelfOptions,
  deps: PullSelfDeps = {}
): Promise<{ changed: boolean; applied: boolean; diff: FileDiff }> {
  const readEnv = deps.readAgentEnv ?? readAgentEnvFromDisk;
  const downloadFromS3 = deps.downloadFromS3 ?? defaultDownloadFromS3;
  const computeCurrentManifest = deps.computeCurrentManifest ?? computeWorkspaceManifest;
  const applyChangesImpl = deps.applyChanges ?? applyDiff;
  const restartGateway = deps.restartGateway ?? defaultRestartGateway;

  // Step 1: Read agent identity
  const env = opts.agentEnvOverride ?? readEnv();
  const { fleetName, agentId, workspaceBase } = env;
  const region = opts.region;
  const bucket = `${fleetName}-ledger`;
  const workspaceDir = path.join(workspaceBase, agentId);

  log.info(`\nfleetmind pull-self — ${agentId} (fleet: ${fleetName})`);

  // Step 2: Compute current workspace manifest
  log.step("Computing current workspace manifest...");
  const currentFiles = computeCurrentManifest(workspaceDir);
  log.dim(`  ${currentFiles.length} files in current workspace`);

  // Step 3: Download incoming manifest from S3
  log.step("Fetching incoming manifest from S3...");
  const manifestKey = `deploy-staging/${agentId}.manifest.json`;
  let incomingManifest: DeployManifest;
  try {
    const manifestBuf = await downloadFromS3(bucket, manifestKey, region);
    incomingManifest = JSON.parse(manifestBuf.toString("utf-8")) as DeployManifest;
  } catch (err) {
    throw new Error(
      `Could not fetch manifest from s3://${bucket}/${manifestKey}: ${String(err)}\n` +
      "Has `fleetmind push fleet` been run for this agent?"
    );
  }

  log.dim(`  incoming: ${incomingManifest.files.length} files (rendered ${incomingManifest.rendered_at})`);

  // Step 4: Compute diff
  const diff = computeDiff(currentFiles, incomingManifest.files);
  const hasChanges = diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;

  if (!hasChanges && !opts.force) {
    log.ok(`No update — workspace matches latest deploy-staging.`);
    return { changed: false, applied: false, diff };
  }

  // Step 5: Print diff (no staging dir yet — byte sizes as fallback for modified files)
  const diffOutput = formatDiff(agentId, diff, incomingManifest.files);
  console.log(diffOutput);

  // Stop here if --dry-run or no --apply
  if (opts.dryRun || !opts.apply) {
    return { changed: true, applied: false, diff };
  }

  // Step 6: Download tarball
  log.step("Downloading tarball...");
  const tarballKey = `deploy-staging/${agentId}.tar.gz`;
  const tarballBuf = await downloadFromS3(bucket, tarballKey, region);
  const tmpBase = os.tmpdir();
  const tarballPath = path.join(tmpBase, `${agentId}.tar.gz`);
  fs.writeFileSync(tarballPath, tarballBuf);

  // Step 7: Verify tarball hash
  log.step("Verifying tarball integrity...");
  verifyTarball(tarballPath, incomingManifest.tarball.sha256);
  log.ok(`  sha256 verified`);

  // Step 8: Extract to staging dir
  const stagingDir = path.join(tmpBase, `fleetmind-pull-staging-${agentId}`);
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  log.step("Extracting tarball...");
  execFileSync("tar", ["xzf", tarballPath, "-C", stagingDir], { stdio: "pipe" });

  // Show per-file diffs if --show-diffs
  if (opts.showDiffs && diff.modified.length > 0) {
    showFileDiffs(stagingDir, workspaceDir, diff.modified, opts.showDiffsFilter, opts.showDiffsFull);
  }

  // Step 9: Apply diff
  log.step("Applying changes...");
  applyChangesImpl(stagingDir, workspaceDir, diff);

  // Cleanup
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.unlinkSync(tarballPath);

  const appliedCount = diff.added.length + diff.modified.length + diff.deleted.length;
  log.success(`\n✓ Applied ${appliedCount} change${appliedCount !== 1 ? "s" : ""} to ${workspaceDir}`);

  // Step 10: Apply workspace patches (idempotent — skip already-applied)
  const patchesPath = path.join(workspaceDir, "PATCHES.md");
  if (fs.existsSync(patchesPath)) {
    log.step("Applying workspace patches...");
    const patchResults = applyWorkspacePatches(patchesPath, workspaceDir);
    const applied = patchResults.filter((r) => r.status === "applied").length;
    const skipped = patchResults.filter((r) => r.status === "skipped").length;
    if (applied > 0) {
      log.ok(`  ${applied} patch${applied !== 1 ? "es" : ""} applied, ${skipped} already up to date`);
    } else if (patchResults.length > 0) {
      log.dim(`  all ${skipped} patches already applied`);
    }
  }

  // Step 11: Restart if requested
  if (opts.restart) {
    log.step(`Restarting openclaw-${agentId}...`);
    restartGateway(agentId);
    log.ok(`  Gateway restarted`);
  } else {
    log.dim(`  Tip: run \`sudo systemctl restart openclaw-${agentId}\` to apply the new config.`);
  }

  return { changed: true, applied: true, diff };
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerPullSelf(program: Command): void {
  program
    .command("pull-self")
    .description("Fetch and apply latest workspace update from S3 (bot-side)")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--dry-run", "Fetch + diff, but do not extract or apply", false)
    .option("--apply", "Apply the diff to the live workspace", false)
    .option("--restart", "Restart gateway after apply", false)
    .option("--force", "Apply even if no changes detected", false)
    .option("--show-diffs [file]", "Show per-file unified diffs for modified files. Optionally filter to a specific file path.")
    .option("--full", "Show full diffs without line cap (use with --show-diffs)", false)
    .addHelpText('after', `
Diff display:
  Default output shows git-stat-style (+added -removed) line counts per file.
  Use --show-diffs to see the actual unified diff for all modified files.
  Use --show-diffs AGENTS.md to see the diff for a specific file only.
  Use --show-diffs --full to bypass the 200-line per-file cap.

Examples:
  # Show diff against the latest deploy-staging manifest
  $ fleetmind pull-self

  # Apply and restart the gateway
  $ fleetmind pull-self --apply --restart

  # See what changed in AGENTS.md before applying
  $ fleetmind pull-self --show-diffs AGENTS.md

  # See full diff for all modified files
  $ fleetmind pull-self --show-diffs --full

  # Force apply even when no changes are detected
  $ fleetmind pull-self --apply --force
`)
    .action(async (opts: {
      region: string;
      dryRun: boolean;
      apply: boolean;
      restart: boolean;
      force: boolean;
      showDiffs?: string | boolean;
      full: boolean;
    }) => {
      try {
        const showDiffsFilter = typeof opts.showDiffs === 'string' ? opts.showDiffs : undefined;
        const { changed, applied } = await runPullSelf({
          region: opts.region,
          dryRun: opts.dryRun,
          apply: opts.apply,
          restart: opts.restart,
          force: opts.force,
          showDiffs: !!opts.showDiffs,
          showDiffsFilter,
          showDiffsFull: opts.full,
        });

        if (changed && !applied && !opts.dryRun) {
          // Showed diff but didn't apply
          log.info("");
          log.dim("Run with --apply to apply these changes.");
          process.exit(0);
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
