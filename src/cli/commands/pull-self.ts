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

export { ManifestFile, DeployManifest };

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
      deleted.push(current);
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
export function formatDiff(
  agentId: string,
  diff: FileDiff,
  incomingFiles: ManifestFile[]
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
    for (const { incoming, currentSize } of diff.modified) {
      lines.push(`    ${incoming.path}  (was ${fmtBytes(currentSize)}, now ${fmtBytes(incoming.size)})`);
    }
  }

  if (diff.deleted.length > 0) {
    const dirRemovals = detectDeletedDirs(diff.deleted, incomingFiles);
    lines.push("  Deleted:");
    for (const f of diff.deleted) {
      const top = f.path.split("/")[0]!;
      const isDir = top !== f.path && dirRemovals.has(top);
      if (isDir) {
        // Print the dir once, not every file
        if (f.path === diff.deleted.find((d) => d.path.startsWith(top + "/"))?.path) {
          const count = dirRemovals.get(top)!;
          lines.push(`    ${top}/  (entire dir, ${count} file${count !== 1 ? "s" : ""})`);
        }
      } else {
        lines.push(`    ${f.path}  (${fmtBytes(f.size)})`);
      }
    }
  }

  // Summary
  const dirRemovals = detectDeletedDirs(diff.deleted, incomingFiles);
  const dirCount = dirRemovals.size;
  const parts: string[] = [];
  if (diff.added.length) parts.push(`${diff.added.length} added`);
  if (diff.modified.length) parts.push(`${diff.modified.length} modified`);
  if (diff.deleted.length) {
    if (dirCount > 0) {
      parts.push(`${diff.deleted.length} deleted (${dirCount} dir removal${dirCount !== 1 ? "s" : ""})`);
    } else {
      parts.push(`${diff.deleted.length} deleted`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${parts.length ? parts.join(", ") : "no changes"}.`);
  lines.push("");
  lines.push("Apply with: fleetmind pull-self --apply [--restart]");

  return lines.join("\n");
}

/** Show per-file unified diffs using the system `diff` tool (capped at 50 lines/file). */
export function showFileDiffs(
  stagingDir: string,
  workspaceDir: string,
  modified: { incoming: ManifestFile; currentSize: number }[]
): void {
  const MAX_LINES = 50;
  for (const { incoming } of modified) {
    const currentPath = path.join(workspaceDir, incoming.path);
    const stagingPath = path.join(stagingDir, incoming.path);
    if (!fs.existsSync(currentPath) || !fs.existsSync(stagingPath)) continue;

    // Only show diffs for text-like files
    try {
      const currentContent = fs.readFileSync(currentPath, "utf-8");
      const stagingContent = fs.readFileSync(stagingPath, "utf-8");
      if (currentContent === stagingContent) continue;

      log.info(`\n--- ${incoming.path} (current)`);
      log.info(`+++ ${incoming.path} (incoming)`);

      // Simple line diff
      const currentLines = currentContent.split("\n");
      const stagingLines = stagingContent.split("\n");
      const maxLen = Math.max(currentLines.length, stagingLines.length);
      let shown = 0;
      for (let i = 0; i < maxLen && shown < MAX_LINES; i++) {
        const c = currentLines[i];
        const s = stagingLines[i];
        if (c !== s) {
          if (c !== undefined) { log.info(`- ${c}`); shown++; }
          if (s !== undefined) { log.info(`+ ${s}`); shown++; }
        }
      }
      if (shown >= MAX_LINES) {
        log.dim("  (diff truncated at 50 lines)");
      }
    } catch {
      // Binary or unreadable — skip
      log.dim(`  ${incoming.path}: (binary or unreadable — skipping inline diff)`);
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
 * Apply diff: copy added/modified from staging to workspace, delete removed.
 * Uses atomic .new → rename for modified files.
 */
export function applyDiff(
  stagingDir: string,
  workspaceDir: string,
  diff: FileDiff
): void {
  // Apply added files
  for (const f of diff.added) {
    const src = path.join(stagingDir, f.path);
    const dest = path.join(workspaceDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    log.info(`  + ${f.path}`);
  }

  // Apply modified files — atomic rename for all except .openclaw/openclaw.json
  for (const { incoming } of diff.modified) {
    const src = path.join(stagingDir, incoming.path);
    const dest = path.join(workspaceDir, incoming.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (incoming.path === ".openclaw/openclaw.json") {
      // OpenClaw handles config reload separately; direct write
      fs.copyFileSync(src, dest);
    } else {
      const tmp = `${dest}.new`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
    }
    log.info(`  ~ ${incoming.path}`);
  }

  // Delete removed files
  for (const f of diff.deleted) {
    const target = path.join(workspaceDir, f.path);
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
        log.info(`  - ${f.path}`);
        // Remove empty parent dirs
        tryRemoveEmptyDir(path.dirname(target), workspaceDir);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          log.warn(`  ! ${f.path} (skipped — permission denied, run as owner to clean up)`);
        } else {
          throw err;
        }
      }
    }
  }
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

  // Step 5: Print diff
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
    showFileDiffs(stagingDir, workspaceDir, diff.modified);
  }

  // Step 9: Apply diff
  log.step("Applying changes...");
  applyChangesImpl(stagingDir, workspaceDir, diff);

  // Cleanup
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.unlinkSync(tarballPath);

  const appliedCount = diff.added.length + diff.modified.length + diff.deleted.length;
  log.success(`\n✓ Applied ${appliedCount} change${appliedCount !== 1 ? "s" : ""} to ${workspaceDir}`);

  // Step 10: Restart if requested
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
    .option("--show-diffs", "Show per-file unified diffs for modified files", false)
    .addHelpText('after', `
Examples:
  # Show diff against the latest deploy-staging manifest (default, no changes applied)
  $ fleetmind pull-self

  # Apply incoming changes without restarting the gateway
  $ fleetmind pull-self --apply

  # Apply and restart the gateway in one shot
  $ fleetmind pull-self --apply --restart

  # Show per-file inline diffs for modified files before applying
  $ fleetmind pull-self --show-diffs

  # Force apply even when no changes are detected
  $ fleetmind pull-self --apply --force
`)
    .action(async (opts: {
      region: string;
      dryRun: boolean;
      apply: boolean;
      restart: boolean;
      force: boolean;
      showDiffs: boolean;
    }) => {
      try {
        const { changed, applied } = await runPullSelf({
          region: opts.region,
          dryRun: opts.dryRun,
          apply: opts.apply,
          restart: opts.restart,
          force: opts.force,
          showDiffs: opts.showDiffs,
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
