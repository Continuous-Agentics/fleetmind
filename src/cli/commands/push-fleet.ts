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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

import { loadFleet } from "../../config/loader.js";
import { provisionFleet } from "../../runtime/provisioner.js";
import { writeOutputs } from "../../runtime/renderer.js";
import {
  buildDeployPlan,
  agentArtifactKeys,
  buildPullSelfCommand,
  buildUpgradeCommand,
} from "../../deploy/plan.js";
import {
  acquireDeployLock,
  releaseDeployLock,
  archiveToHistory as archiveToHistoryGeneric,
  listHistory,
  type ArtifactStore,
  type TargetResolver,
  type CommandRunner,
} from "../../deploy/transport.js";
import { fleetProvider, artifactStoreFor, transportFor } from "../../deploy/factory.js";
import { log } from "../../utils/log.js";

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
   * Provider factories — defaults build the AWS adapters from the deploy plan.
   * Tests inject fakes here. The bucket / fleet name are passed at construction
   * (not per call) so an adapter binds them once.
   */
  makeArtifactStore?: (bucket: string, region: string) => ArtifactStore;
  makeTargetResolver?: (fleetName: string, region: string) => TargetResolver;
  makeCommandRunner?: (region: string) => CommandRunner;

  /** Override the lock acquire/release (e.g. no-op in tests). */
  acquireLock?: (store: ArtifactStore, lockKey: string) => Promise<void>;
  releaseLock?: (store: ArtifactStore, lockKey: string) => Promise<void>;
  /** Override history archiving (e.g. no-op in tests). */
  archiveToHistory?: (store: ArtifactStore, agentId: string, sha256: string) => Promise<void>;
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
 * Staging-tarball path prefix for the two operator-shipped OpenClaw config
 * files (`openclaw.json` / `openclaw.base.json`). On the target host these
 * deploy under the canonical OpenClaw config/state directory
 * (`<home>/.openclaw/`, see ../../core/model.ts's `standardConfigDir`) — a
 * SIBLING of the workspace directory (`<home>/.openclaw/workspace/`), not a
 * subdirectory inside it. Staging them under this distinct, workspace-shaped
 * prefix (rather than reusing the literal `.openclaw/` name, which inside the
 * *workspace* tree means agent-owned runtime state — see PROTECTED_PATHS in
 * pull-self.ts) keeps the tarball's manifest paths unambiguous: pull-self
 * routes anything under this prefix to the config dir, and everything else to
 * the workspace dir.
 */
export const CONFIG_STAGING_PREFIX = ".openclaw-config";

/**
 * Build a staging directory for the tarball.
 * Copies workspace files + the two operator-shipped OpenClaw config files
 * into a flat staging area. Returns the staging dir path.
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

  // Stage openclaw.json under CONFIG_STAGING_PREFIX/ AND a
  // CONFIG_STAGING_PREFIX/openclaw.base.json snapshot. pull-self uses the
  // base to compute (live - base) = operator config patches, then merges
  // those patches on top of the incoming rendered config so live config
  // changes (e.g. from 'openclaw config patch' in chat) survive pushes.
  // These deploy to the canonical config dir (<home>/.openclaw/), NOT into
  // the workspace — see CONFIG_STAGING_PREFIX above.
  if (fs.existsSync(renderedOcJsonPath)) {
    const configStagingDir = path.join(staging, CONFIG_STAGING_PREFIX);
    fs.mkdirSync(configStagingDir, { recursive: true });
    fs.copyFileSync(renderedOcJsonPath, path.join(configStagingDir, "openclaw.json"));
    fs.copyFileSync(renderedOcJsonPath, path.join(configStagingDir, "openclaw.base.json"));
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
  const acquireLockFn = deps.acquireLock ?? acquireDeployLock;
  const releaseLockFn = deps.releaseLock ?? releaseDeployLock;
  const archiveToHistoryFn = deps.archiveToHistory ?? archiveToHistoryGeneric;

  const fleetFile = opts.fleet ?? "fleet.yaml";
  const fleet = loadFleet(fleetFile);
  const fleetName = fleet.fleet.name;
  const localBase = opts.localBase ?? process.cwd();
  const region = opts.region;
  const version = opts.fleetmindVersion ?? resolveFleetmindVersion();
  const tmpBase = os.tmpdir();

  // Determine target agents
  const targetIds = opts.agents?.length
    ? opts.agents
    : fleet.agents.list.map((a) => a.id);

  // Plan the deploy: bucket, per-agent artifact keys, and local input paths.
  const plan = buildDeployPlan(fleet, { region, version, localBase, agentIds: targetIds });

  // Select + construct the deploy-transport providers for the fleet's target
  // provider (AWS adapters for aws-ssm; local-fs/exec for local). Tests inject
  // fakes via the deps factories.
  const provider = fleetProvider(fleet);
  const fleetPath = path.resolve(fleetFile);
  const store = deps.makeArtifactStore
    ? deps.makeArtifactStore(plan.bucket, region)
    : artifactStoreFor(fleet, { bucket: plan.bucket, region });
  const transport = transportFor(provider, { fleetName, region });
  const resolver = deps.makeTargetResolver ? deps.makeTargetResolver(fleetName, region) : transport.resolver;
  const runner = deps.makeCommandRunner ? deps.makeCommandRunner(region) : transport.runner;

  // Acquire fleet-wide lock (prevents concurrent pushes racing on the store)
  if (!opts.noLock && !opts.dryRun) {
    await acquireLockFn(store, plan.lockKey);
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
      const history = await listHistory(store, agentId);
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
      const keys = agentArtifactKeys(agentId);
      // Promote history tarball + manifest to current
      await store.copy(entry.key, keys.tarball);
      if (entry.manifest) {
        await store.copy(entry.manifest, keys.manifest);
      }
      log.ok(`  ${agentId}: history entry ${n} promoted to current`);

      if (!opts.noApply) {
        const instanceId = await resolver.resolveHost(agentId);
        if (instanceId) {
          const agent = fleet.getAgent(agentId)!;
          const target = fleet.targetForAgent(agent);
          const cmd = buildPullSelfCommand({
            provider,
            restart: opts.restart,
            region,
            agentId,
            fleetPath,
            runtimeUser: target.provider === "aws-ssm" ? target.aws.runtime_user : undefined,
          });
          const cmdId = await runner.run(instanceId, [cmd]);
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

    // Per-agent plan: rendered workspace dir + openclaw.json path (the latter
    // derived from fleet.outputs.openclaw_json so fleets with custom output
    // paths are honored) and the artifact-store keys.
    const agentPlan = plan.agents.find((a) => a.agentId === agentId)!;
    const keys = agentPlan.keys;

    // Build staging directory (workspace files + .openclaw/openclaw.json)
    const stagingDir = buildStagingDir(agentId, agentPlan.workspaceDir, agentPlan.ocJsonPath, tmpBase);

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
    const tarballPath = path.join(tmpBase, keys.tarballFilename);
    const { sha256: tarballHash, sizeBytes: tarballSize } = await createTarball(stagingDir, tarballPath);
    log.info(`    tarball: ${keys.tarballFilename} (${formatBytes(tarballSize)}, sha256=${tarballHash.slice(0, 12)}...)`);

    // Build manifest
    const manifest = buildManifest(agentId, fleetName, version, files, {
      filename: keys.tarballFilename,
      sha256: tarballHash,
      sizeBytes: tarballSize,
    });

    // Archive current bundle to history before overwriting
    if (!opts.dryRun) {
      await archiveToHistoryFn(store, agentId, tarballHash);
    }

    log.step(`    uploading s3://${plan.bucket}/${keys.tarball}...`);
    const tarballBuf = fs.readFileSync(tarballPath);
    await store.put(keys.tarball, tarballBuf);

    log.step(`    uploading s3://${plan.bucket}/${keys.manifest}...`);
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf-8");
    await store.put(keys.manifest, manifestBuf);

    log.ok(`  ${agentId}: artifacts uploaded`);

    // Trigger apply on the host — skip when --no-apply is set
    if (!opts.noApply) {
      try {
        log.step(`    looking up ${agentId} instance in SSM...`);
        const instanceId = await resolver.resolveHost(agentId);
        if (!instanceId) {
          log.warn(`  ${agentId}: instance not found in SSM (fleet_name=${fleetName}, agent_id=${agentId}) — skipping SSM trigger`);
          results.push({ agent_id: agentId, status: "pushed", reason: "instance not in SSM" });
        } else {
          const commands: string[] = [];
          if (opts.upgradeCli) {
            // Prepend upgrade step. && ensures pull-self never runs on a
            // stale binary if the upgrade fails.
            commands.push(buildUpgradeCommand(opts.upgradeCli));
          }
          const target = fleet.targetForAgent(agent);
          commands.push(buildPullSelfCommand({
            provider,
            restart: opts.restart,
            region,
            agentId,
            fleetPath,
            runtimeUser: target.provider === "aws-ssm" ? target.aws.runtime_user : undefined,
          }));

          const label = opts.upgradeCli ? 'upgrade + pull-self' : 'pull-self';
          log.step(`    sending ${label} command to ${instanceId}...`);
          const cmdId = await runner.run(instanceId, commands);
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
      await releaseLockFn(store, plan.lockKey);
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
  When --upgrade-cli is set, each instance runs a single SSM RunCommand that
  self-upgrades the fleetmind binary, then re-runs pull-self in the runtime
  account's user-systemd session. The two steps are chained with && so
  pull-self never runs on a stale binary if the upgrade fails. Monitor the
  command output with:
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
