import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { RuntimeAwsAccess, type RuntimeAwsAccessConfig } from "../config/aws-access.js";

export const AWS_ACCESS_PATH = "/etc/fleetmind/aws-access.json";
export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  originalExpiration?: Date;
}
export interface Identity { Account?: string; Arn?: string }
export interface AccessDeps {
  readCatalog(): RuntimeAwsAccessConfig;
  source(): Promise<Credentials>;
  identity(credentials: Credentials, region: string): Promise<Identity>;
  assume(credentials: Credentials, region: string, role: string, session: string, duration: number): Promise<Credentials>;
  audit(event: Record<string, string>): void;
  now(): number;
}

/** No env/CWD path lookup. Every ancestor and the opened file must be root-owned,
 * non-symlink, and not writable by the agent. Same-UID processes are not a sandbox. */
export function readAccessCatalog(): RuntimeAwsAccessConfig {
  for (const dir of ["/", "/etc", "/etc/fleetmind"]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("Untrusted AWS access directory");
  }
  const fd = fs.openSync(AWS_ACCESS_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 65536) throw new Error("Untrusted AWS access catalog");
    return RuntimeAwsAccess.parse(JSON.parse(fs.readFileSync(fd, "utf8")));
  } finally { fs.closeSync(fd); }
}

export function verifyRole(identity: Identity, role: string, session?: string): void {
  const account = role.split(":")[4];
  const name = role.split("/").at(-1)!;
  const prefix = `arn:aws:sts::${account}:assumed-role/${name}/`;
  if (identity.Account !== account || !identity.Arn?.startsWith(prefix) ||
      !identity.Arn.slice(prefix.length) || (session && identity.Arn !== prefix + session)) {
    throw new Error("AWS access identity mismatch");
  }
}

export function requireFresh(credentials: Credentials, now: number): void {
  const expiration = credentials.originalExpiration ?? credentials.expiration;
  if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken ||
      !expiration || !Number.isFinite(expiration.getTime()) || expiration.getTime() <= now + 30_000) {
    throw new Error("AWS access credentials unavailable or expired");
  }
}

/** A fresh task session; never consults the default credential chain or returns
 * source credentials. Re-read catalog before issuing to close removal races. */
export async function authorizeTask(alias: string, deps: AccessDeps) {
  const run = randomUUID();
  let agent = "unknown";
  try {
    const catalog = RuntimeAwsAccess.parse(deps.readCatalog());
    agent = catalog.agent;
    if (!Object.hasOwn(catalog.targets, alias)) throw new Error("Unknown AWS access target");
    const target = catalog.targets[alias];
    const source = await deps.source();
    requireFresh(source, deps.now());
    const sourceIdentity = await deps.identity(source, catalog.source_region);
    verifyRole(sourceIdentity, catalog.source_role_arn);
    const session = `fm-${agent.slice(0, 20)}-${run}`;
    const credentials = await deps.assume(source, target.region, target.role_arn, session, target.duration_seconds);
    requireFresh(credentials, deps.now());
    const identity = await deps.identity(credentials, target.region);
    verifyRole(identity, target.role_arn, session);
    // A removed or changed grant cannot complete an in-flight authorization.
    const current = RuntimeAwsAccess.parse(deps.readCatalog());
    if (current.agent !== catalog.agent || current.source_role_arn !== catalog.source_role_arn ||
        JSON.stringify(current.targets[alias]) !== JSON.stringify(target)) throw new Error("AWS access grant changed");
    requireFresh(credentials, deps.now());
    deps.audit({ event: "aws-access.authorized", agent, run, target: alias, account: target.account_id,
      role: target.role_arn, source_role: catalog.source_role_arn, source_identity: sourceIdentity.Arn!,
      session, identity: identity.Arn!, expires: credentials.expiration!.toISOString() });
    return { credentials, region: target.region, run };
  } catch {
    // Do not include arbitrary SDK errors, command args, credential values or
    // user-supplied aliases (including newlines) in audit output.
    deps.audit({ event: "aws-access.denied", agent, run });
    throw new Error("AWS access denied (unknown target, identity, credentials or grant failure)");
  }
}

/** Deliberately small inherited environment. Neither operator profiles, SDK
 * endpoint overrides, process injection nor host service tokens cross over. */
export function cleanAccessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent/fleetmind-aws-access",
    ...(env.TERM ? { TERM: env.TERM } : {}),
    LANG: "C.UTF-8", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://169.254.169.254",
    AWS_EC2_METADATA_V1_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
  };
}

export function taskEnvironment(credentials: Credentials, region: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  requireFresh(credentials, Date.now());
  return { ...cleanAccessEnvironment(env), AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_SESSION_TOKEN: credentials.sessionToken,
    AWS_REGION: region, AWS_DEFAULT_REGION: region, AWS_EC2_METADATA_DISABLED: "true" };
}

/** External commands cannot refresh environment credentials. Bound the whole
 * process group to STS expiry minus 30 seconds; longer work starts a new task. */
export async function executeTask(command: string[], credentials: Credentials, region: string): Promise<number> {
  if (!command.length || !command[0]) throw new Error("AWS access requires a command");
  const env = taskEnvironment(credentials, region, process.env);
  const deadline = credentials.expiration!.getTime() - Date.now() - 30_000;
  if (deadline <= 0 || deadline > 3_600_000) throw new Error("Invalid AWS access session lifetime");
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: "inherit", detached: true, shell: false });
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already exited */ } }
    };
    const interrupt = () => killGroup("SIGINT");
    const terminate = () => killGroup("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    let expired = false;
    const timer = setTimeout(() => { expired = true; killGroup("SIGKILL"); }, deadline);
    const cleanup = () => {
      clearTimeout(timer); process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      // Do not leave subprocesses retaining credentials after their leader exits.
      killGroup("SIGKILL");
    };
    child.once("error", () => { cleanup(); reject(new Error("AWS access command could not start")); });
    child.once("exit", code => { cleanup(); resolve(expired ? 124 : (code ?? 1)); });
  });
}
