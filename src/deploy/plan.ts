/**
 * Deploy planning — the "what to deploy" decisions, isolated from the I/O that
 * carries them out.
 *
 * Previously these were derived ad-hoc inside push-fleet.ts: the artifact-store
 * bucket (`<fleet>-ledger`), the S3 keys (`deploy-staging/<agent>.tar.gz`, …),
 * the lock key, and the SSM command strings were all string-built at the call
 * site. Centralizing them here gives the deploy flow one explicit contract and
 * a pure, testable seam ahead of the provider abstraction (ArtifactStore /
 * TargetRunner / ServiceManager).
 *
 * This module is intentionally provider-neutral and side-effect free: it
 * decides keys, paths, and commands; it does not touch S3, SSM, or the disk.
 */

import path from "node:path";
import type { Fleet, TargetProvider } from "../config/schema.js";
import { resolveOpenClawBaseDir } from "../runtime/renderer.js";

/** Root prefix for all deploy artifacts in the artifact store. */
export const DEPLOY_STAGING_PREFIX = "deploy-staging";

/** Artifact-store key for the fleet-wide deploy lock. */
export const DEPLOY_LOCK_KEY = `${DEPLOY_STAGING_PREFIX}/lock.json`;

/** Maximum history entries retained per agent. */
export const HISTORY_MAX = 5;

/** The artifact-store keys for a single agent's deploy bundle. */
export interface ArtifactKeys {
  /** Tarball basename: `<agent>.tar.gz`. */
  tarballFilename: string;
  /** Tarball key: `deploy-staging/<agent>.tar.gz`. */
  tarball: string;
  /** Manifest key: `deploy-staging/<agent>.manifest.json`. */
  manifest: string;
  /** History listing prefix: `deploy-staging/history/<agent>/`. */
  historyPrefix: string;
}

/** Compute the artifact-store keys for an agent. */
export function agentArtifactKeys(agentId: string): ArtifactKeys {
  const tarballFilename = `${agentId}.tar.gz`;
  return {
    tarballFilename,
    tarball: `${DEPLOY_STAGING_PREFIX}/${tarballFilename}`,
    manifest: `${DEPLOY_STAGING_PREFIX}/${agentId}.manifest.json`,
    historyPrefix: `${DEPLOY_STAGING_PREFIX}/history/${agentId}/`,
  };
}

/**
 * Resolve the artifact-store bucket. Honors `deploy.artifact_store` (s3) when
 * set; otherwise falls back to the legacy `<fleet-name>-ledger` convention so
 * fleets that don't declare a deploy block behave exactly as before.
 */
export function resolveArtifactBucket(fleet: Fleet): string {
  const store = fleet.deploy?.artifact_store;
  if (store?.provider === "s3") return store.s3.bucket;
  return `${fleet.fleet.name}-ledger`;
}

export interface PullSelfCommandOptions {
  /** The host's target provider — selects how pull-self is invoked. */
  provider: TargetProvider;
  restart: boolean;
  region: string;
  agentId: string;
  /** Fleet config path the host loads to learn its target (local/ssh). */
  fleetPath?: string;
}

/**
 * The on-host command that pulls and applies the latest workspace bundle.
 * Provider-specific: on AWS the SSM command runs as root and drops to ec2-user
 * and needs the region (for the S3 store); on a local/ssh host it runs as the
 * connecting user and learns its target by loading the fleet config.
 */
export function buildPullSelfCommand(opts: PullSelfCommandOptions): string {
  const restartFlag = opts.restart ? " --restart" : "";
  if (opts.provider === "aws-ssm") {
    return `sudo -u ec2-user fleetmind pull-self --apply${restartFlag} --region ${opts.region}`;
  }
  const fleetFlag = opts.fleetPath ? ` --fleet ${opts.fleetPath}` : "";
  return `fleetmind pull-self --apply${restartFlag} --agent ${opts.agentId}${fleetFlag}`;
}

/** The on-host command that upgrades the fleetmind CLI before applying. */
export function buildUpgradeCommand(version: string): string {
  const flag = version === "latest" ? "--latest" : `--to ${version}`;
  return `sudo fleetmind self-upgrade ${flag} --apply`;
}

/** Per-agent deploy plan: where the rendered inputs are and where they go. */
export interface AgentDeployPlan {
  agentId: string;
  isOrchestrator: boolean;
  /** Local rendered workspace directory for this agent. */
  workspaceDir: string;
  /** Local rendered openclaw.json path for this agent. */
  ocJsonPath: string;
  keys: ArtifactKeys;
}

/** Fleet-wide deploy plan. */
export interface DeployPlan {
  fleetName: string;
  region: string;
  /** Artifact-store bucket (S3 today). */
  bucket: string;
  /** fleetmind version stamped into manifests. */
  version: string;
  /** Local working directory holding the rendered/ outputs. */
  localBase: string;
  /** Artifact-store key for the fleet-wide deploy lock. */
  lockKey: string;
  /** Per-agent plans, for the requested agents that exist in the fleet. */
  agents: AgentDeployPlan[];
}

export interface BuildDeployPlanOptions {
  region: string;
  version: string;
  localBase: string;
  /** Agent ids to target. Ids not present in the fleet are omitted from
   *  `agents` — the caller decides how to report unknown ids. */
  agentIds: string[];
}

/** Build the deploy plan for a fleet. Pure: no S3/SSM/filesystem access. */
export function buildDeployPlan(fleet: Fleet, opts: BuildDeployPlanOptions): DeployPlan {
  const ocBaseDir = resolveOpenClawBaseDir(fleet.outputs.openclaw_json, opts.localBase);
  const agents: AgentDeployPlan[] = [];
  for (const agentId of opts.agentIds) {
    const agent = fleet.getAgent(agentId);
    if (!agent) continue;
    agents.push({
      agentId,
      isOrchestrator: agent.orchestrator,
      workspaceDir: path.join(opts.localBase, "rendered", "workspaces", agentId),
      ocJsonPath: path.join(ocBaseDir, agentId, "openclaw.json"),
      keys: agentArtifactKeys(agentId),
    });
  }
  return {
    fleetName: fleet.fleet.name,
    region: opts.region,
    bucket: resolveArtifactBucket(fleet),
    version: opts.version,
    localBase: opts.localBase,
    lockKey: DEPLOY_LOCK_KEY,
    agents,
  };
}
