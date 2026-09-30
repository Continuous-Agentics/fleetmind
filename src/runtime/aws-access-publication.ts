import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AwsAccessHost, RuntimeAwsAccess, type AwsAccessHostConfig, type RuntimeAwsAccessConfig } from "../config/aws-access.js";
import { requireFresh, verifyRole } from "./aws-access.js";
import { withAwsAuthorization, type AuthorizationOptions } from "./aws-access-aws.js";

export const ACCESS_CAPABILITY = "fleetmind-aws-access-sync-v2";
export function validatePublication(catalog: RuntimeAwsAccessConfig | null, input: AwsAccessHostConfig): void {
  const host = AwsAccessHost.parse(input);
  if (catalog !== null) {
    const parsed = RuntimeAwsAccess.parse(catalog);
    if (parsed.agent !== host.agent || parsed.source_role_arn !== host.role_arn || parsed.source_region !== host.region) {
      throw new Error("Catalog does not match independent host binding");
    }
  }
}

/** Test seam is programmatic only; the root CLI always uses fixed defaults. */
export interface PublicationOptions extends AuthorizationOptions {
  directory?: string;
  ownerUid?: number;
  lockTimeoutMs?: number;
}

function trustedDirectory(directory: string, uid: number): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022)) throw new Error("Untrusted host identity directory");
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function trustedRead(file: string, uid: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) || stat.size > 65536) throw new Error("Untrusted host identity file");
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}
function verifyHostFile(directory: string, uid: number, host: AwsAccessHostConfig): void {
  const text = trustedRead(path.join(directory, "agent.env"), uid);
  for (const [key, expected] of [["FLEET_NAME", host.fleet], ["AGENT_ID", host.agent]]) {
    const matches = [...text.matchAll(new RegExp(`^${key}=([^\\r\\n]+)$`, "gm"))];
    if (matches.length !== 1 || matches[0][1] !== expected) throw new Error("Trusted host fleet/agent mismatch");
  }
}

/** Verify independent root-owned bootstrap metadata AND actual IMDS workload
 * identity before touching the catalog. Catalog contents never authorize writes. */
export async function publishAccess(catalog: RuntimeAwsAccessConfig | null, input: AwsAccessHostConfig, options: PublicationOptions = {}): Promise<"unchanged" | "published" | "removed"> {
  const host = AwsAccessHost.parse(input);
  validatePublication(catalog, host);
  const directory = options.directory ?? "/etc/fleetmind";
  const uid = options.ownerUid ?? 0;
  if (!options.directory) { trustedDirectory("/", 0); trustedDirectory("/etc", 0); }
  trustedDirectory(directory, uid);
  verifyHostFile(directory, uid, host);
  await withAwsAuthorization(async deps => {
    const credentials = await deps.source();
    requireFresh(credentials, Date.now());
    verifyRole(await deps.identity(credentials, host.region), host.role_arn);
  }, options);
  const body = catalog ? JSON.stringify(RuntimeAwsAccess.parse(catalog), null, 2) + "\n" : null;
  if (body && Buffer.byteLength(body) > 65536) throw new Error("AWS access catalog exceeds 64 KiB");
  const lock = path.join(directory, ".aws-access.lock");
  const deadline = Date.now() + (options.lockTimeoutMs ?? 5000);
  while (true) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error("Catalog publication lock unavailable");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const destination = path.join(directory, "aws-access.json");
  const temporary = path.join(directory, `.aws-access.${randomUUID()}`);
  try {
    trustedDirectory(directory, uid);
    verifyHostFile(directory, uid, host);
    if (!body) {
      try { fs.unlinkSync(destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "removed";
        throw error;
      }
      syncDirectory(directory);
      return "removed";
    }
    try {
      if (trustedRead(destination, uid) === body && (fs.statSync(destination).mode & 0o777) === 0o644) return "unchanged";
    } catch { /* Missing/untrusted destination is atomically replaced, never followed. */ }
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, body); fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    syncDirectory(directory);
    return "published";
  } finally {
    try {
      try { fs.unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } finally { fs.rmdirSync(lock); }
  }
}
