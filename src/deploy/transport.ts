/**
 * Deploy transport — provider-neutral interfaces and the generic mechanics
 * built on them.
 *
 * Three contracts the deploy flow needs, none of them AWS-specific:
 *   - ArtifactStore: blob storage for the deploy bundles (put/get/copy/list/delete)
 *   - TargetResolver: agent id -> an opaque host handle (or null if unreachable)
 *   - CommandRunner: run a fixed command on a resolved host
 *
 * The concrete adapters live next to this file (aws.ts today; ssh.ts / local.ts
 * next). The deploy *lock* and *history* logic live here as generic functions
 * over an ArtifactStore, so they work unchanged on S3, local-fs, or any future
 * store — they used to be hard-wired to the S3 SDK inside push-fleet.
 */

import os from "node:os";
import { HISTORY_MAX, type ArtifactKeys, agentArtifactKeys } from "./plan.js";

// ── Provider contracts ─────────────────────────────────────────────────────

/** Blob storage for deploy artifacts. Keys are store-relative (e.g.
 *  `deploy-staging/<agent>.tar.gz`); the backing location (bucket, root dir) is
 *  bound when the adapter is constructed. */
export interface ArtifactStore {
  put(key: string, body: Buffer): Promise<void>;
  /** Fetch an object, or null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Server-side/in-store copy from one key to another. */
  copy(srcKey: string, destKey: string): Promise<void>;
  /** List object keys under a prefix. */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** Resolves an agent to an opaque host handle the CommandRunner understands
 *  (an EC2 instance id for SSM, `user@host` for SSH, "" for local). Returns
 *  null when the host isn't reachable/registered. */
export interface TargetResolver {
  resolveHost(agentId: string): Promise<string | null>;
}

/** Runs commands on a resolved host. Returns an opaque id (SSM command id, or a
 *  synthetic id for ssh/local) for follow-up/reporting. */
export interface CommandRunner {
  run(hostHandle: string, commands: string[]): Promise<string>;
}

// ── Deploy lock (generic over ArtifactStore) ────────────────────────────────

const LOCK_TTL_SECONDS = 300;

interface LockInfo {
  acquired_at: string;
  holder: string;
  ttl_seconds: number;
}

/** Acquire the fleet-wide deploy lock. Throws if a live lock is held by someone
 *  else; overrides a stale (expired) lock. */
export async function acquireDeployLock(store: ArtifactStore, lockKey: string): Promise<void> {
  const holder = `${process.env.USER ?? "unknown"}@${os.hostname()}`;

  const existing = await store.get(lockKey);
  if (existing) {
    const info = JSON.parse(existing.toString()) as LockInfo;
    const ageSeconds = (Date.now() - new Date(info.acquired_at).getTime()) / 1000;
    if (ageSeconds < info.ttl_seconds) {
      throw new Error(
        `Fleet is locked by ${info.holder} (acquired ${Math.round(ageSeconds)}s ago, ` +
          `TTL ${info.ttl_seconds}s). Wait for the other push to finish, or delete the ` +
          `lock object (${lockKey}) to force-release.`
      );
    }
  }

  const lock: LockInfo = {
    acquired_at: new Date().toISOString(),
    holder,
    ttl_seconds: LOCK_TTL_SECONDS,
  };
  await store.put(lockKey, Buffer.from(JSON.stringify(lock, null, 2), "utf-8"));
}

/** Release the fleet-wide deploy lock (best-effort; TTL expires it otherwise). */
export async function releaseDeployLock(store: ArtifactStore, lockKey: string): Promise<void> {
  try {
    await store.delete(lockKey);
  } catch {
    // Best-effort — the TTL will expire a stuck lock.
  }
}

// ── History (generic over ArtifactStore) ────────────────────────────────────

/**
 * Before overwriting an agent's current bundle, copy it (and its manifest) into
 * the history prefix, then prune to the most recent HISTORY_MAX. Best-effort:
 * a fresh agent with no current bundle, or a copy failure, never fails a push.
 */
export async function archiveToHistory(
  store: ArtifactStore,
  agentId: string,
  currentSha256: string
): Promise<void> {
  const keys = agentArtifactKeys(agentId);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = `${keys.historyPrefix}${ts}-${currentSha256.slice(0, 8)}.tar.gz`;
  try {
    await store.copy(keys.tarball, dst);
    await store.copy(keys.manifest, dst.replace(".tar.gz", ".manifest.json"));

    const all = await store.list(keys.historyPrefix);
    const tarballs = all.filter((k) => k.endsWith(".tar.gz")).sort((a, b) => a.localeCompare(b));
    const toDelete = tarballs.slice(0, Math.max(0, tarballs.length - HISTORY_MAX));
    for (const key of toDelete) {
      await store.delete(key);
      await store.delete(key.replace(".tar.gz", ".manifest.json"));
    }
  } catch {
    // History is best-effort — don't fail the push if archiving fails.
  }
}

export interface HistoryEntry {
  key: string;
  manifest: string;
  timestamp: string;
}

/** List an agent's history entries, newest first. */
export async function listHistory(store: ArtifactStore, agentId: string): Promise<HistoryEntry[]> {
  const keys: ArtifactKeys = agentArtifactKeys(agentId);
  const all = await store.list(keys.historyPrefix);
  return all
    .filter((k) => k.endsWith(".tar.gz"))
    .sort((a, b) => b.localeCompare(a)) // newest first
    .map((key) => ({
      key,
      manifest: key.replace(".tar.gz", ".manifest.json"),
      timestamp: key
        .split("/")
        .pop()!
        .split("-")
        .slice(0, 3)
        .join("T")
        .replace("T", " ")
        .replace(/-/g, ":")
        .substring(0, 19),
    }));
}
