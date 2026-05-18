/**
 * fleetmind push fleet — package, upload, and trigger fleet-wide workspace updates.
 *
 * Packages rendered workspaces + per-agent openclaw.json into a signed tarball,
 * uploads tarball + manifest to S3 deploy-staging, then sends SSM commands to
 * trigger `fleetmind pull-self --apply` on each agent instance.
 *
 * Usage:
 *   fleetmind push fleet [--dry-run] [--restart] [--no-apply] [--agent <id>]
 */

import crypto from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { Command } from "commander";

// Resolve the running fleetmind version from package.json so the manifest's
// `fleetmind_version` field reflects what was actually installed. Mirrors
// the pattern used for `fleetmind --version` (PR #60).
function resolveFleetmindVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  SendCommandCommand,
  DescribeInstanceInformationCommand,
} from "@aws-sdk/client-ssm";

import { loadFleet } from "../../config/loader.js";
import { provisionFleet } from "../../runtime/provisioner.js";
import { writeOutputs, resolveOpenClawBaseDir } from "../../runtime/renderer.js";
import { log } from "../../utils/log.js";

// ── AWS client helpers ───────────────────────────────────────────────────────

/** Request timeout for all SSM API calls. Prevents indefinite hangs on
 *  transient AWS API failures — the SDK's default retry logic has no wall-clock
 *  limit, which can block `push fleet` for many minutes on a single stuck call. */
const SSM_REQUEST_TIMEOUT_MS = 30_000;

function makeSsmClient(region: string): SSMClient {
  return new SSMClient({ region, requestHandler: { requestTimeout: SSM_REQUEST_TIMEOUT_MS } });
}


// ── Types ─────────────────────────────────────────────────────────────────────

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface DeployManifest {
  agent_id: string;
  fleet_name: string;
  fleetmind_version: string;
  rendered_at: string;
  tarball: {
    filename: string;
    size_bytes: number;
    sha256: string;
  };
  files: ManifestFile[];
}

export interface PushFleetResult {
  agent_id: string;
  status: "pushed" | "skipped" | "error";
  /** RunCommand command ID. */
  ssm_command_id?: string;
  reason?: string;
}

// ── Dependency injection ──────────────────────────────────────────────────────

export interface PushFleetDeps {
  /**
   * Create workspace tarball.
   * @param stagingDir  directory containing all workspace files (flat, workspace-root-relative)
   * @param destPath    path to write <agent>.tar.gz
   * @returns sha256 hex and size in bytes of the tarball
   */
  createTarball?: (stagingDir: string, destPath: string) => Promise<{ sha256: string; sizeBytes: number }>;

  /**
   * Upload a Buffer to S3.
   */
  uploadToS3?: (bucket: string, key: string, body: Buffer, region: string) => Promise<void>;

  /**
   * Look up EC2 instance ID via SSM DescribeInstanceInformation tag filters.
   * Returns null when the instance isn't registered / not found.
   */
  lookupInstance?: (fleetName: string, agentId: string, region: string) => Promise<string | null>;

  /**
   * Send an SSM run-shell-script command. Returns the command ID.
   * For --upgrade-cli, multiple commands are passed and run sequentially
   * with && semantics (pull-self only runs if upgrade exits 0).
   */
  sendSsmCommand?: (instanceId: string, commands: string[], region: string) => Promise<string>;
  /** Override the lock acquire/release for testing. */
  acquireLock?: (bucket: string, region: string) => Promise<void>;
  releaseLock?: (bucket: string, region: string) => Promise<void>;
  /** Override history archiving for testing. */
  archiveToHistory?: (bucket: string, agentId: string, sha256: string, region: string) => Promise<void>;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Walk a directory and compute sha256 + stat for every file.
 * Returns paths relative to baseDir, using forward-slash separators.
 */
export function computeFileManifests(baseDir: string): ManifestFile[] {
  const results: ManifestFile[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const rel = path.relative(baseDir, abs).replace(/\\/g, "/");
        const stat = fs.statSync(abs);
        const content = fs.readFileSync(abs);
        const sha256 = crypto.createHash("sha256").update(content).digest("hex");
        // mode: last 3 octal digits (e.g. 644)
        const mode = parseInt((stat.mode & 0o777).toString(8), 10);
        results.push({ path: rel, size: stat.size, sha256, mode });
      }
    }
  }

  if (fs.existsSync(baseDir)) walk(baseDir);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/** Compute sha256 of a file on disk. */
export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Format bytes for human display. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a staging directory for the tarball.
 * Copies workspace files + .openclaw/openclaw.json into a flat staging area.
 * Returns the staging dir path.
 */
export function buildStagingDir(
  agentId: string,
  renderedWorkspaceDir: string,
  renderedOcJsonPath: string,
  tmpBase: string
): string {
  const staging = path.join(tmpBase, `fleetmind-push-staging-${agentId}`);
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });

  // Copy workspace files
  if (fs.existsSync(renderedWorkspaceDir)) {
    copyDirSync(renderedWorkspaceDir, staging);
  }

  // Copy openclaw.json into .openclaw/ AND a .openclaw/openclaw.base.json snapshot.
  // pull-self uses the base to compute (live - base) = operator config patches,
  // then merges those patches on top of the incoming rendered config so live
  // config changes (e.g. from 'openclaw config patch' in chat) survive pushes.
  if (fs.existsSync(renderedOcJsonPath)) {
    const oclawDir = path.join(staging, ".openclaw");
    fs.mkdirSync(oclawDir, { recursive: true });
    fs.copyFileSync(renderedOcJsonPath, path.join(oclawDir, "openclaw.json"));
    fs.copyFileSync(renderedOcJsonPath, path.join(oclawDir, "openclaw.base.json"));
  }

  return staging;
}

/**
 * Copies fleet.yaml into the staging directory so agents can run
 * fleetmind CLI commands (fleetmind status, fleetmind task, etc.)
 * from their own workspace without needing the operator's machine.
 */


function copyDirSync(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Build a DeployManifest from files in stagingDir. */
export function buildManifest(
  agentId: string,
  fleetName: string,
  fleetmindVersion: string,
  files: ManifestFile[],
  tarballInfo: { filename: string; sha256: string; sizeBytes: number }
): DeployManifest {
  return {
    agent_id: agentId,
    fleet_name: fleetName,
    fleetmind_version: fleetmindVersion,
    rendered_at: new Date().toISOString(),
    tarball: {
      filename: tarballInfo.filename,
      size_bytes: tarballInfo.sizeBytes,
      sha256: tarballInfo.sha256,
    },
    files,
  };
}

// ── Default production implementations ───────────────────────────────────────

async function defaultCreateTarball(
  stagingDir: string,
  destPath: string
): Promise<{ sha256: string; sizeBytes: number }> {
  // tar czf <destPath> -C <stagingDir> .
  execFileSync("tar", ["czf", destPath, "-C", stagingDir, "."], { stdio: "pipe" });
  const buf = fs.readFileSync(destPath);
  return {
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    sizeBytes: buf.length,
  };
}

async function defaultUploadToS3(
  bucket: string,
  key: string,
  body: Buffer,
  region: string
): Promise<void> {
  const s3 = new S3Client({ region });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

async function defaultLookupInstance(
  fleetName: string,
  agentId: string,
  region: string
): Promise<string | null> {
  // Tag keys must match the fleetmind:* namespace set by infra/terraform/ec2.tf.
  // Unprefixed `fleet_name` / `agent_id` tags don't exist on the instances.
  const ssm = makeSsmClient(region);
  const resp = await ssm.send(
    new DescribeInstanceInformationCommand({
      Filters: [
        { Key: "tag:fleetmind:fleet_name", Values: [fleetName] },
        { Key: "tag:fleetmind:agent_id", Values: [agentId] },
      ],
    })
  );
  const instances = resp.InstanceInformationList ?? [];
  return instances[0]?.InstanceId ?? null;
}

async function defaultSendSsmCommand(
  instanceId: string,
  commands: string[],
  region: string
): Promise<string> {
  const ssm = makeSsmClient(region);
  const resp = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands },
    })
  );
  return resp.Command?.CommandId ?? "";
}

// ── Fleet-wide S3 lock ───────────────────────────────────────────────────────

const LOCK_KEY = "deploy-staging/lock.json";
const LOCK_TTL_SECONDS = 300;

interface LockInfo {
  acquired_at: string;
  holder: string;
  ttl_seconds: number;
}

/** Try to acquire the fleet deploy lock. Throws if locked by another operator. */
async function acquireLock(bucket: string, region: string): Promise<void> {
  const s3 = new S3Client({ region });
  const holder = `${process.env.USER ?? 'unknown'}@${os.hostname()}`;

  // Check if a lock exists and whether it has expired.
  try {
    const existing = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: LOCK_KEY }));
    const raw = await existing.Body?.transformToString();
    if (raw) {
      const info = JSON.parse(raw) as LockInfo;
      const ageSeconds = (Date.now() - new Date(info.acquired_at).getTime()) / 1000;
      if (ageSeconds < info.ttl_seconds) {
        throw new Error(
          `Fleet is locked by ${info.holder} (acquired ${Math.round(ageSeconds)}s ago, TTL ${info.ttl_seconds}s). ` +
          `Wait for the other push to finish, or delete s3://${bucket}/${LOCK_KEY} to force-release.`
        );
      }
      log.dim(`  (stale lock from ${info.holder} expired after ${Math.round(ageSeconds)}s — overriding)`);
    }
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== 'NoSuchKey' && !(err instanceof Error && err.message.includes('locked by'))) {
      // Ignore missing key; rethrow lock-held error; ignore other S3 errors (bucket may be new)
    } else if (err instanceof Error && err.message.includes('locked by')) {
      throw err;
    }
  }

  const lock: LockInfo = {
    acquired_at: new Date().toISOString(),
    holder,
    ttl_seconds: LOCK_TTL_SECONDS,
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: LOCK_KEY,
    Body: JSON.stringify(lock, null, 2),
    ContentType: "application/json",
  }));
  log.dim(`  🔒 lock acquired by ${holder}`);
}

/** Release the fleet deploy lock. */
async function releaseLock(bucket: string, region: string): Promise<void> {
  const s3 = new S3Client({ region });
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: LOCK_KEY }));
    log.dim(`  🔓 lock released`);
  } catch {
    // Best-effort release — TTL will expire it if delete fails
  }
}

// ── History management ────────────────────────────────────────────────────────

const HISTORY_MAX = 5;

/**
 * Before uploading a new tarball, copy the current one to history.
 * History key: deploy-staging/history/<agent>/<iso-timestamp>-<sha256prefix>.tar.gz
 */
async function archiveToHistory(
  bucket: string,
  agentId: string,
  currentSha256: string,
  region: string
): Promise<void> {
  const s3 = new S3Client({ region });
  const src = `deploy-staging/${agentId}.tar.gz`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = `deploy-staging/history/${agentId}/${ts}-${currentSha256.slice(0, 8)}.tar.gz`;

  try {
    // Copy existing tarball to history
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${src}`,
      Key: dst,
    }));

    // Also copy the manifest
    const manifestSrc = `deploy-staging/${agentId}.manifest.json`;
    const manifestDst = dst.replace('.tar.gz', '.manifest.json');
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${manifestSrc}`,
      Key: manifestDst,
    }));

    // Prune old history entries (keep last HISTORY_MAX)
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `deploy-staging/history/${agentId}/`,
    }));
    const tarballs = (list.Contents ?? [])
      .filter(o => o.Key?.endsWith('.tar.gz'))
      .sort((a, b) => (a.Key ?? '').localeCompare(b.Key ?? ''));
    const toDelete = tarballs.slice(0, Math.max(0, tarballs.length - HISTORY_MAX));
    for (const obj of toDelete) {
      if (obj.Key) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key.replace('.tar.gz', '.manifest.json') }));
      }
    }
  } catch {
    // History is best-effort — don't fail the push if archiving fails
    log.dim(`  (history archive skipped — no previous tarball)`);
  }
}

/**
 * List available history entries for an agent, newest first.
 */
export async function listHistory(
  bucket: string,
  agentId: string,
  region: string
): Promise<{ key: string; manifest?: string; timestamp: string }[]> {
  const s3 = new S3Client({ region });
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: `deploy-staging/history/${agentId}/`,
  }));
  return (list.Contents ?? [])
    .filter(o => o.Key?.endsWith('.tar.gz'))
    .sort((a, b) => (b.Key ?? '').localeCompare(a.Key ?? ''))  // newest first
    .map(o => ({
      key: o.Key!,
      manifest: o.Key!.replace('.tar.gz', '.manifest.json'),
      timestamp: o.Key!.split('/').pop()!.split('-').slice(0, 3).join('T').replace('T', ' ').replace(/-/g, ':').substring(0, 19),
    }));
}

// ── Core logic ────────────────────────────────────────────────────────────────

export interface PushFleetOptions {
  fleet?: string;
  agents?: string[];
  region: string;
  restart: boolean;
  dryRun: boolean;
  noApply: boolean;
  /**
   * When set, run a CLI upgrade on each instance via SSM Automation before
   * syncing the workspace. "latest" upgrades to the newest published version;
   * a semver string pins to that version.
   *
   * The upgrade runs as a separate SSM Automation step with onFailure: Abort.
   * pull-self is only triggered after the upgrade step succeeds, so a failed
   * upgrade can never silently fall through to pull-self on a stale binary.
   */
  upgradeCli?: string;
  /**
   * When set, roll back to a previous deployment instead of pushing a new one.
   * Value is the history index to roll back to: 1 = most recent, 2 = second-most-recent, etc.
   * Defaults to 1 when --rollback flag is passed without a value.
   */
  rollback?: number;
  /** Skip the concurrency lock (use only for debugging or when lock is stale). */
  noLock?: boolean;
  localBase?: string;
  fleetmindVersion?: string;
}

/**
 * Main push-fleet logic. Pure enough to test — all side-effectful operations
 * are injectable via `deps`.
 */
export async function runPushFleet(
  opts: PushFleetOptions,
  deps: PushFleetDeps = {}
): Promise<PushFleetResult[]> {
  const createTarball = deps.createTarball ?? defaultCreateTarball;
  const uploadToS3 = deps.uploadToS3 ?? defaultUploadToS3;
  const lookupInstance = deps.lookupInstance ?? defaultLookupInstance;
  const sendSsmCommand = deps.sendSsmCommand ?? defaultSendSsmCommand;
  const acquireLockFn = deps.acquireLock ?? acquireLock;
  const releaseLockFn = deps.releaseLock ?? releaseLock;
  const archiveToHistoryFn = deps.archiveToHistory ?? archiveToHistory;

  const fleetFile = opts.fleet ?? "fleet.yaml";
  const fleet = loadFleet(fleetFile);
  const fleetName = fleet.fleet.name;
  const localBase = opts.localBase ?? process.cwd();
  const region = opts.region;
  const bucket = `${fleetName}-ledger`;
  const version = opts.fleetmindVersion ?? resolveFleetmindVersion();
  const tmpBase = os.tmpdir();

  // Determine target agents
  const targetIds = opts.agents?.length
    ? opts.agents
    : fleet.agents.list.map((a) => a.id);

  // Acquire fleet-wide lock (prevents concurrent pushes racing on S3)
  if (!opts.noLock && !opts.dryRun) {
    await acquireLockFn(bucket, region);
  }

  // --upgrade-cli uses a single RunCommand (upgrade && pull-self) rather than
  // an SSM Automation document. The && operator provides the same fail-fast
  // guarantee: pull-self only runs if the upgrade exits 0. This avoids the
  // SSM Automation document dependency (IAM to manage documents, upsert logic,
  // document version tracking) for a simple two-step sequential operation.

  const results: PushFleetResult[] = [];

  try {

  // Handle --rollback mode: promote a history entry to current instead of building new
  if (opts.rollback !== undefined) {
    const n = opts.rollback < 1 ? 1 : opts.rollback;
    for (const agentId of targetIds) {
      log.step(`Rolling back ${agentId} to history entry ${n}...`);
      const history = await listHistory(bucket, agentId, region);
      if (history.length === 0) {
        log.warn(`  ${agentId}: no history entries found — skipping`);
        results.push({ agent_id: agentId, status: "skipped", reason: "no history" });
        continue;
      }
      const entry = history[n - 1];
      if (!entry) {
        log.warn(`  ${agentId}: history entry ${n} not found (only ${history.length} available) — skipping`);
        results.push({ agent_id: agentId, status: "skipped", reason: `history entry ${n} not found` });
        continue;
      }
      log.dim(`  ← restoring ${entry.key.split('/').pop()}`);
      const s3 = new S3Client({ region });
      // Promote history tarball to current
      await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${entry.key}`, Key: `deploy-staging/${agentId}.tar.gz` }));
      if (entry.manifest) {
        await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${entry.manifest}`, Key: `deploy-staging/${agentId}.manifest.json` }));
      }
      log.ok(`  ${agentId}: history entry ${n} promoted to current`);

      if (!opts.noApply) {
        const instanceId = await lookupInstance(fleetName, agentId, region);
        if (instanceId) {
          const restartFlag = opts.restart ? " --restart" : "";
          const cmd = `sudo -u ec2-user fleetmind pull-self --apply${restartFlag} --region ${region}`;
          const cmdId = await sendSsmCommand(instanceId, [cmd], region);
          log.ok(`  ${agentId}: rollback SSM command sent → ${cmdId}`);
          results.push({ agent_id: agentId, status: "pushed", ssm_command_id: cmdId });
        } else {
          log.warn(`  ${agentId}: instance not found in SSM`);
          results.push({ agent_id: agentId, status: "pushed", reason: "instance not in SSM" });
        }
      } else {
        results.push({ agent_id: agentId, status: "pushed", reason: "--no-apply" });
      }
    }
    return results;
  }

  // Step 1: Render fleet workspaces
  log.step("Rendering fleet workspaces...");
  await provisionFleet(fleet, false, localBase);
  writeOutputs(fleet);

  for (const agentId of targetIds) {
    const agent = fleet.getAgent(agentId);
    if (!agent) {
      log.warn(`  Agent '${agentId}' not found in fleet — skipping`);
      results.push({ agent_id: agentId, status: "skipped", reason: "not found in fleet" });
      continue;
    }

    log.step(`Packaging ${agent.emoji} ${agent.name} (${agentId})...`);

    const workspaceDir = path.join(localBase, "rendered", "workspaces", agentId);
    // Per-agent openclaw.json (rendered by writeOutputs). Derive the base dir
    // from fleet.outputs.openclaw_json so fleets with custom output paths (e.g.
    // ./rendered/openclaw-<fleet>.json for parallel-fleet deploys) are honored.
    // Previously hardcoded to ./rendered/openclaw/<agent>/openclaw.json which
    // silently broke push for any fleet not using the default output path —
    // tarballs went up without openclaw.json, CondPathExists never satisfied,
    // gateway never started on first deploy.
    const ocBaseDir = resolveOpenClawBaseDir(fleet.outputs.openclaw_json, localBase);
    const ocJsonPath = path.join(ocBaseDir, agentId, "openclaw.json");

    // Build staging directory (workspace files + .openclaw/openclaw.json)
    const stagingDir = buildStagingDir(agentId, workspaceDir, ocJsonPath, tmpBase);

    // Ship cron/jobs.json for orchestrator (PM) agents so sweep jobs land at
    // $WORKSPACE_DIR/.openclaw/cron/jobs.json and are hot-reloaded by the gateway.
    if (agent.orchestrator) {
      const cronJobsPath = path.join(localBase, "rendered", "cron", "jobs.json");
      if (fs.existsSync(cronJobsPath)) {
        const cronDir = path.join(stagingDir, ".openclaw", "cron");
        fs.mkdirSync(cronDir, { recursive: true });
        fs.copyFileSync(cronJobsPath, path.join(cronDir, "jobs.json"));
        log.dim(`    cron/jobs.json included`);
      }
    }

    // Compute file manifests from staging
    const files = computeFileManifests(stagingDir);
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    log.info(`    ${files.length} files, ${formatBytes(totalSize)}`);

    if (opts.dryRun) {
      log.ok(`  [dry-run] ${agentId}: would package ${files.length} files (${formatBytes(totalSize)})`);
      results.push({ agent_id: agentId, status: "skipped", reason: "dry-run" });
      // Clean up staging
      fs.rmSync(stagingDir, { recursive: true, force: true });
      continue;
    }

    // Create tarball
    const tarballFilename = `${agentId}.tar.gz`;
    const tarballPath = path.join(tmpBase, tarballFilename);
    const { sha256: tarballHash, sizeBytes: tarballSize } = await createTarball(stagingDir, tarballPath);
    log.info(`    tarball: ${tarballFilename} (${formatBytes(tarballSize)}, sha256=${tarballHash.slice(0, 12)}...)`);

    // Build manifest
    const manifest = buildManifest(agentId, fleetName, version, files, {
      filename: tarballFilename,
      sha256: tarballHash,
      sizeBytes: tarballSize,
    });

    // Upload tarball + manifest (always, unless dry-run which was handled above)
    const tarballKey = `deploy-staging/${tarballFilename}`;

    // Archive current tarball to history before overwriting
    if (!opts.dryRun) {
      await archiveToHistoryFn(bucket, agentId, tarballHash, region);
    }

    log.step(`    uploading s3://${bucket}/${tarballKey}...`);
    const tarballBuf = fs.readFileSync(tarballPath);
    await uploadToS3(bucket, tarballKey, tarballBuf, region);

    const manifestKey = `deploy-staging/${agentId}.manifest.json`;
    log.step(`    uploading s3://${bucket}/${manifestKey}...`);
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf-8");
    await uploadToS3(bucket, manifestKey, manifestBuf, region);

    log.ok(`  ${agentId}: artifacts uploaded`);

    // Trigger SSM — skip when --no-apply is set
    if (!opts.noApply) {
      try {
        const instanceId = await lookupInstance(fleetName, agentId, region);
        if (!instanceId) {
          log.warn(`  ${agentId}: instance not found in SSM (fleet_name=${fleetName}, agent_id=${agentId}) — skipping SSM trigger`);
          results.push({ agent_id: agentId, status: "pushed", reason: "instance not in SSM" });
        } else {
          const restartFlag = opts.restart ? " --restart" : "";
          const pullSelfArgs = `--apply${restartFlag} --region ${region}`;

          const commands: string[] = [];
          if (opts.upgradeCli) {
            // Prepend upgrade step. && ensures pull-self never runs on a
            // stale binary if the upgrade fails.
            const upgradeFlag = opts.upgradeCli === 'latest'
              ? '--latest'
              : `--version ${opts.upgradeCli}`;
            commands.push(`sudo fleetmind self-upgrade ${upgradeFlag} --apply`);
          }
          commands.push(`sudo -u ec2-user fleetmind pull-self ${pullSelfArgs}`);

          const label = opts.upgradeCli ? 'upgrade + pull-self' : 'pull-self';
          log.step(`    sending ${label} command to ${instanceId}...`);
          const cmdId = await sendSsmCommand(instanceId, commands, region);
          log.ok(`  ${agentId}: SSM command sent → ${cmdId}`);
          log.dim(`    follow up: aws ssm get-command-invocation --command-id ${cmdId} --instance-id ${instanceId} --region ${region}`);
          results.push({ agent_id: agentId, status: "pushed", ssm_command_id: cmdId });
        }
      } catch (err) {
        log.warn(`  ${agentId}: SSM trigger failed — ${String(err)}`);
        results.push({ agent_id: agentId, status: "error", reason: String(err) });
      }
    } else {
      log.ok(`  ${agentId}: artifacts uploaded (--no-apply: SSM trigger skipped)`);
      results.push({ agent_id: agentId, status: "pushed", reason: "--no-apply" });
    }

    // Clean up staging + temp tarball
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (fs.existsSync(tarballPath)) fs.unlinkSync(tarballPath);
  }

  // Summary
  log.info("");
  log.bold("Push summary:");
  for (const r of results) {
    if (r.status === "pushed") {
      const ref = r.ssm_command_id ? ` (cmd=${r.ssm_command_id})` : "";
      log.ok(`  ${r.agent_id}: pushed${ref}${r.reason ? ` [${r.reason}]` : ""}`);
    } else if (r.status === "skipped") {
      log.dim(`  ${r.agent_id}: skipped (${r.reason})`);
    } else {
      log.error(`  ${r.agent_id}: error — ${r.reason}`);
    }
  }

  } finally {
    if (!opts.noLock && !opts.dryRun) {
      await releaseLockFn(bucket, region);
    }
  }

  return results;
}

// ── Commander registration ────────────────────────────────────────────────────

/**
 * Register `fleetmind push fleet` under an existing `push` Command.
 * Called from registerPush() in push.ts.
 */
export function registerPushFleet(pushCmd: Command): void {
  pushCmd
    .command("fleet")
    .description("Package workspaces, upload to S3, and trigger pull-self on each agent")
    .option("--fleet <path>", "fleet.yaml path (default: ./fleet.yaml)")
    .option("-a, --agent <id>", "Only push to this agent (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--restart", "Restart gateway after apply on each agent", false)
    .option("--upgrade-cli [version]", "Upgrade fleetmind CLI on each instance before applying. Defaults to 'latest' if no version is specified. Use a semver string to pin (e.g. --upgrade-cli 0.4.13).")
    .option("--rollback [n]", "Roll back to a previous deployment (1 = most recent, 2 = second-most-recent, etc.). Skips render and push; promotes history entry to current and triggers pull-self.")
    .option("--no-lock", "Skip the S3 concurrency lock (use only for debugging or when the lock is stale)")
    .option("--dry-run", "Package locally and compute manifest, but skip upload and SSM", false)
    .option("--no-apply", "Upload to S3 but skip SSM trigger")  // Commander's --no-* sets opts.apply=true by default; --no-apply flips to false. Do NOT pass a default value here (would shadow Commander's inverse-flag semantics).
    .addHelpText('after', `
Concurrency:
  A fleet-wide S3 lock prevents concurrent pushes from racing.
  If another push is in progress, this command will fail with the holder
  and elapsed time. To force-release a stale lock:
    aws s3 rm s3://<fleet>-ledger/deploy-staging/lock.json

History:
  Before each push, the current tarball is archived to:
    s3://<fleet>-ledger/deploy-staging/history/<agent>/<timestamp>-<sha>.tar.gz
  Last 5 deployments are kept per agent.

Upgrade behaviour:
  When --upgrade-cli is set, the upgrade and workspace sync run as a single
  SSM RunCommand with && sequencing:
    sudo fleetmind self-upgrade <flag> --apply && sudo -u ec2-user fleetmind pull-self --apply
  The && operator ensures pull-self never runs on a stale binary if the upgrade
  fails. Monitor the command output with:
    aws ssm get-command-invocation --command-id <id> --instance-id <id> --region <region>

Examples:
  # Standard push with restart
  $ fleetmind push fleet --restart

  # Push AND upgrade CLI to latest
  $ fleetmind push fleet --restart --upgrade-cli

  # Pin CLI upgrade to a specific version
  $ fleetmind push fleet --restart --upgrade-cli 0.5.3

  # Roll back all agents to the previous deployment
  $ fleetmind push fleet --rollback --restart

  # Roll back to 2 deployments ago
  $ fleetmind push fleet --rollback 2 --restart

  # Dry-run: package + manifest, skip upload and SSM
  $ fleetmind push fleet --dry-run

  # Push to one agent only
  $ fleetmind push fleet --agent ariadne

  # Upload to S3 but skip the SSM trigger
  $ fleetmind push fleet --no-apply
`)
    .action(async (opts: {
      fleet?: string;
      agent: string[];
      region: string;
      restart: boolean;
      upgradeCli?: string | boolean;
      rollback?: string | boolean;
      lock: boolean;  // commander --no-lock sets opts.lock = false
      dryRun: boolean;
      apply: boolean;  // commander --no-apply sets opts.apply = false
    }) => {
      try {
        const upgradeCli = opts.upgradeCli === true ? 'latest'
          : typeof opts.upgradeCli === 'string' ? opts.upgradeCli
          : undefined;
        const rollback = opts.rollback === true ? 1
          : typeof opts.rollback === 'string' ? parseInt(opts.rollback, 10) || 1
          : undefined;
        await runPushFleet({
          fleet: opts.fleet,
          agents: opts.agent,
          region: opts.region,
          restart: opts.restart,
          upgradeCli,
          rollback,
          noLock: opts.lock === false,
          dryRun: opts.dryRun,
          noApply: opts.apply === false,
        });
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
