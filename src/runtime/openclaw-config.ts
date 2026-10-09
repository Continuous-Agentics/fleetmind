import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export const TESTED_OPENCLAW_VERSION = "2026.9.5";
export const MINIMUM_SUPPORTED_OPENCLAW_VERSION = TESTED_OPENCLAW_VERSION;
export const OPENCLAW_BINARY_ENV = "FLEETMIND_OPENCLAW_BIN";
type Json = Record<string, any>;
const object = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

export type ConfigSource = "incoming" | "live" | "base";
/** Never surface parser/fs diagnostics: malformed config can contain secrets. */
export function readOpenClawConfig(file: string, source: ConfigSource): Json {
  return readOpenClawSnapshot(file, source).config;
}

/** Parse the exact bytes retained for optimistic publication, never a second read. */
export function readOpenClawSnapshot(file: string, source: ConfigSource): { config: Json; bytes: Buffer } {
  try {
    const bytes = fs.readFileSync(file);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(value)) throw new Error();
    // Guard the structures traversed by normalization/merge. The target CLI
    // remains authoritative for the full schema and plugin contract.
    const cfg = value;
    for (const key of ["agents", "channels"]) if (key in cfg && !object(cfg[key])) throw new Error();
    if (cfg.bindings !== undefined && (!Array.isArray(cfg.bindings) || cfg.bindings.some((b: unknown) => !object(b) || !object(b.match)))) throw new Error();
    const agents = cfg.agents;
    if (agents) {
      if (agents.list !== undefined && (!Array.isArray(agents.list) || agents.list.some((a: unknown) => !object(a)))) throw new Error();
      if (agents.entries !== undefined && (!object(agents.entries) || Object.values(agents.entries).some((a) => !object(a)))) throw new Error();
      if (agents.defaults !== undefined && !object(agents.defaults)) throw new Error();
    }
    return { config: cfg, bytes };
  } catch {
    throw new Error(`Cannot read ${source} OpenClaw config: expected a readable JSON object with valid config structure; repair that source and retry (contents withheld)`);
  }
}

/** Snapshot the normalized input before any validation callback/subprocess. */
export function freezeIncomingConfig(file: string): Json {
  const freeze = (value: any): any => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze(normalizeOpenClawConfig(readOpenClawConfig(file, "incoming")));
}

/** Normalize FleetMind's historical roster only. Ambiguous/include-based legacy
 * ownership must be repaired by OpenClaw/operator, never guessed here. */
export function normalizeOpenClawConfig(input: Json): Json {
  const cfg: Json = structuredClone(input);
  if (cfg.$include) throw new Error("FleetMind config merge does not support $include; reconcile with OpenClaw first");
  const agents = cfg.agents;
  // Retired knobs from historical FleetMind renders have no current equivalents.
  for (const entry of [agents?.defaults, ...Object.values(agents?.entries ?? {}), ...(agents?.list ?? [])]) {
    if (!object(entry)) continue;
    if (object(entry.contextLimits)) {
      delete entry.contextLimits.toolResultMaxChars;
      if (!Object.keys(entry.contextLimits).length) delete entry.contextLimits;
    }
    if (object(entry.compaction)) {
      for (const key of ["reserveTokens", "maxHistoryShare", "truncateAfterCompaction"]) delete entry.compaction[key];
    }
  }
  if (!object(agents) || !Array.isArray(agents.list)) return cfg;
  const entries: Json = {};
  for (const entry of agents.list) {
    if (!object(entry) || typeof entry.id !== "string" || !entry.id || Object.hasOwn(entries, entry.id)) {
      throw new Error("Invalid or duplicate legacy agent identity");
    }
    const { id, default: retired, ...rest } = entry;
    Object.defineProperty(entries, id, { value: rest, enumerable: true, writable: true, configurable: true });
  }
  if (agents.entries && !sameStructure(agents.entries, entries)) {
    throw new Error("Conflicting legacy and canonical agent rosters; reconcile with OpenClaw first");
  }
  const marked = agents.list.filter((a: Json) => a.default === true);
  if (marked.length > 1) throw new Error("Multiple legacy default agents");
  if (marked.length && agents.ownership === "explicit") throw new Error("Conflicting explicit ownership and legacy default marker");
  const ids = Object.keys(entries);
  const owner = marked[0]?.id ?? agents.list[0]?.id;
  if (ids.length > 1) {
    agents.defaults ??= {};
    const defaultOwner = marked[0]?.id ?? (ids.includes("main") ? "main" : undefined);
    if (defaultOwner) {
      agents.defaults.systemAgent ??= { agentId: defaultOwner };
      if (!Object.values(entries).some((entry: any) => entry.heartbeat !== undefined)) {
        agents.defaults.heartbeat ??= {};
        agents.defaults.heartbeat.agentId ??= defaultOwner;
      }
      agents.defaults.authInheritance ??= { agentId: defaultOwner };
      if (cfg.session?.store) agents.defaults.sessionStore ??= { agentId: defaultOwner };
    }
    // Preserve account-wide implicit traffic without replacing narrower routes.
    cfg.bindings ??= [];
    for (const [channel, settings] of Object.entries(cfg.channels ?? {})) {
      if (channel === "defaults" || !object(settings)) continue;
      const accounts = object(settings.accounts) ? Object.keys(settings.accounts) : ["default"];
      for (const accountId of accounts) {
        const bound = cfg.bindings.some((b: Json) => b.match?.channel === channel &&
          ((b.match.accountId ?? "default") === accountId || b.match.accountId === "*") && !b.match.peer && !b.match.guildId && !b.match.teamId);
        if (!bound) cfg.bindings.push({ agentId: owner, match: { channel, accountId } });
      }
    }
  }
  if (ids.length > 1) agents.ownership = "explicit";
  agents.entries = entries;
  delete agents.list;
  return cfg;
}

/** Recursive three-way merge: untouched leaves adopt new fleet values, operator
 * changes/deletions survive. Arrays are policy units, not index-merged. */
function merge(base: any, live: any, incoming: any): any {
  if (JSON.stringify(base) === JSON.stringify(live)) return structuredClone(incoming);
  if ((base === undefined || object(base)) && object(live) && object(incoming)) {
    base ??= {};
    const out: Json = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(live), ...Object.keys(incoming)])) {
      const value = merge(base[k], live[k], incoming[k]);
      if (value !== undefined) Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return structuredClone(live);
}

// Only these per-agent values belong wholly to the fleet. In particular model
// primary/fallbacks form one billing/routing policy unit, not a leaf-level patch.
const FLEET_AGENT_FIELDS = ["name", "workspace", "agentDir", "model"] as const;
const routingConflict = () => new Error("OpenClaw binding ownership conflict: a fleet-managed match was changed/deleted, or an operator match collides with incoming routing. Reconcile fleet.yaml and live bindings to the same route/removal, then retry (binding values withheld)");
const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
const sameStructure = (a: any, b: any) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
/** Match identity follows the tested target's routing normalizations. This is
 * ownership comparison, not a substitute for the target CLI schema validator. */
function routeKey(route: Json): string {
  const match = route.match ?? {};
  const text = (v: any) => String(v ?? "").trim();
  const rawAccount = text(match.accountId);
  const account = rawAccount === "*" ? "*" : rawAccount.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const kind = text(match.peer?.kind).toLowerCase();
  return JSON.stringify(stable({
    channel: text(match.channel).toLowerCase(),
    accountId: !account || ["__proto__", "prototype", "constructor"].includes(account) ? "default" : account,
    peer: match.peer ? { kind: kind === "channel" ? "group" : kind === "dm" ? "direct" : kind, id: text(match.peer.id) } : null,
    guildId: text(match.guildId), teamId: text(match.teamId),
    roles: Array.isArray(match.roles) ? [...new Set(match.roles)].sort() : [],
  }));
}
function routeMap(routes: Json[]): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const route of routes) {
    // Omitted accountId and "default" have the same match semantics. Type is
    // deliberately not a discriminator: route/acp cannot silently shadow each other.
    const key = routeKey(route);
    if (out.has(key)) throw routingConflict();
    out.set(key, route);
  }
  return out;
}
function mergeBindings(base: Json[], live: Json[], incoming: Json[]): Json[] {
  const b = routeMap(base), l = routeMap(live), n = routeMap(incoming);
  for (const [key, route] of b) {
    if (!sameStructure(route, l.get(key)) && !sameStructure(l.get(key), n.get(key))) throw routingConflict();
  }
  for (const [key, route] of l) {
    if (!b.has(key) && n.has(key) && !sameStructure(route, n.get(key))) throw routingConflict();
  }
  // Fleet-owned matches follow incoming (including removals); unmanaged live
  // routes retain their relative order. Distinct narrower matches keep their tier.
  return [...incoming, ...live.filter((route) => {
    const key = routeKey(route);
    return !b.has(key) && !n.has(key);
  })];
}

export function mergeCanonicalConfigs(incomingRaw: Json, liveRaw?: Json, baseRaw?: Json): Json {
  const incoming = normalizeOpenClawConfig(incomingRaw);
  if (!liveRaw) return incoming;
  const live = normalizeOpenClawConfig(liveRaw);
  // Unknown baseline: treat all live settings as operator-owned, rather than wiping credentials.
  const base = baseRaw ? normalizeOpenClawConfig(baseRaw) : {};
  const result = merge(base, live, incoming);
  result.agents ??= {};
  result.agents.entries ??= {};
  // Fleet controls roster membership and rendered routing fields, not local per-agent tools/memory/auth.
  for (const id of Object.keys(base.agents?.entries ?? {})) {
    if (!Object.hasOwn(incoming.agents?.entries ?? {}, id)) delete result.agents.entries[id];
  }
  for (const [id, fields] of Object.entries(incoming.agents?.entries ?? {})) {
    const entry = { ...result.agents.entries[id] };
    for (const field of FLEET_AGENT_FIELDS) {
      if (Object.hasOwn(fields as Json, field)) entry[field] = structuredClone((fields as Json)[field]);
      else if (Object.hasOwn(base.agents?.entries?.[id] ?? {}, field)) delete entry[field];
    }
    Object.defineProperty(result.agents.entries, id, {
      value: entry, enumerable: true, writable: true, configurable: true,
    });
  }
  if (incoming.agents?.ownership) result.agents.ownership = incoming.agents.ownership;
  // When FleetMind opts into service-owned updates, the selected channel is
  // fleet policy rather than an unmanaged local leaf. Removing the opt-in also
  // removes the channel FleetMind previously owned.
  if (incoming.update?.channel !== undefined) {
    result.update ??= {};
    result.update.channel = incoming.update.channel;
  } else if (base.update?.channel !== undefined) {
    delete result.update?.channel;
    if (result.update && Object.keys(result.update).length === 0) delete result.update;
  }
  if (incoming.bindings !== undefined || base.bindings !== undefined || live.bindings !== undefined) {
    result.bindings = mergeBindings(base.bindings ?? [], live.bindings ?? [], incoming.bindings ?? []);
  }
  if (JSON.stringify(result) !== JSON.stringify(incoming)) result._patched = true;
  return result;
}

export function assertSupportedNode(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !(Number(match[1]) === 24 && Number(match[2]) >= 16 || Number(match[1]) >= 26 && (Number(match[1]) > 26 || Number(match[2]) >= 1))) {
    throw new Error("Supported OpenClaw releases require Node >=24.16.0 <25 or >=26.1.0");
  }
}

/** Strict SemVer: canonical numeric identifiers, arbitrary-size integers, and
 * prerelease precedence. Build metadata has no effect on ordering. */
function semver(value: string): { core: bigint[]; pre: string[] } | null {
  const tokens = value.trim().split(/\s+/);
  const candidates = tokens.filter((token) => /^[0-9]+\./.test(token));
  if (candidates.length !== 1) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(candidates[0]);
  if (!match) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((id) => /^\d+$/.test(id) && !/^(0|[1-9]\d*)$/.test(id))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function isSupportedOpenClawVersion(versionOutput: string): boolean {
  const actual = semver(versionOutput);
  const minimum = semver(MINIMUM_SUPPORTED_OPENCLAW_VERSION);
  if (!actual || !minimum) return false;
  for (let i = 0; i < 3; i += 1) {
    if (actual.core[i] !== minimum.core[i]) return actual.core[i] > minimum.core[i];
  }
  if (!actual.pre.length || !minimum.pre.length) return !actual.pre.length;
  for (let i = 0; i < Math.max(actual.pre.length, minimum.pre.length); i += 1) {
    const a = actual.pre[i], b = minimum.pre[i];
    if (a === b) continue;
    if (a === undefined || b === undefined) return b === undefined;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    if (an && bn) return BigInt(a) > BigInt(b);
    if (an !== bn) return bn;
    return a > b;
  }
  return true;
}

/** Resolve the host-selected launcher once. A configured launcher is
 * authoritative: a missing/unsafe value fails closed instead of falling back to
 * an older system package retained for recovery. */
export function resolveOpenClawBinary(env: NodeJS.ProcessEnv = process.env): string {
  // SSM sudo intentionally drops ambient variables. The runtime account's
  // persistent selector therefore participates even on older bootstraps.
  const selector = path.join(env.HOME || os.homedir(), ".config/fleetmind/openclaw-runtime.json");
  let selected: string | undefined;
  let selectorExists = false;
  try { fs.lstatSync(selector); selectorExists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (selectorExists) {
    const data = JSON.parse(fs.readFileSync(selector, "utf8"));
    if (typeof data.binary !== "string" || !data.binary.trim()) throw new Error("Invalid OpenClaw runtime selector");
    selected = data.binary;
  }
  const configured = env[OPENCLAW_BINARY_ENV]?.trim() || selected;
  if (!configured) return "openclaw";
  if (!path.isAbsolute(configured)) throw new Error(`${OPENCLAW_BINARY_ENV} must be an absolute path`);
  const resolved = fs.realpathSync(configured);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${OPENCLAW_BINARY_ENV} must resolve to a regular file`);
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

/** Target CLI owns full schema/plugin and linked-SQLite validation. FleetMind
 * sets only a minimum migration contract, then capability-probes the active
 * launcher with `config validate`; patch/future releases are not rejected
 * before their actual schema validator runs. No subprocess diagnostics are
 * surfaced because candidate/config output can contain secret values. */
export function validateOpenClawCandidate(candidatePath: string): void {
  assertSupportedNode(process.version);
  try {
    const env = { ...process.env, OPENCLAW_CONFIG_PATH: candidatePath,
      OPENCLAW_STATE_DIR: path.dirname(candidatePath), OPENCLAW_CONFIG_READONLY: "1" };
    const openclawBin = resolveOpenClawBinary(env);
    const version = execFileSync(openclawBin, ["--version"], { env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    if (!isSupportedOpenClawVersion(version)) throw new Error("unsupported version");
    execFileSync(openclawBin, ["config", "validate", "--json"], {
      env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    throw new Error(`OpenClaw candidate validation failed (requires ${MINIMUM_SUPPORTED_OPENCLAW_VERSION}+ and a compatible config validator); live config unchanged. Check the active launcher, plugins and config with the operator's OpenClaw CLI.`);
  }
}

export type ConfigValidator = (candidatePath: string) => void;
/** Exclusive private sibling + rename. Candidate failure never changes live bytes. */
export function publishOpenClawConfig(destination: string, config: Json,
  validate: ConfigValidator = validateOpenClawCandidate, expectedLive?: Buffer | null): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("Refusing symlink config");
  // Merge callers supply their exact source bytes (null means originally absent).
  // Unmerged writes, such as the baseline, snapshot at publication entry.
  const previous = expectedLive === undefined ? readDestination() : expectedLive;
  function readDestination(): Buffer | null {
    try {
      if (!fs.existsSync(destination)) return null;
      if (fs.lstatSync(destination).isSymbolicLink()) throw new Error();
      return fs.readFileSync(destination);
    } catch {
      throw new Error("Cannot read publication destination safely (contents withheld)");
    }
  }
  function assertUnchanged(phase: string): void {
    const current = readDestination();
    if (previous === null ? current !== null : !current?.equals(previous)) {
      throw new Error(`Config changed ${phase}; retry from the current live file`);
    }
  }
  const candidate = path.join(path.dirname(destination), `.fleetmind-config-${randomUUID()}.json`);
  try {
    const clean = { ...config }; delete clean._patched;
    const expected = Buffer.from(JSON.stringify(clean, null, 2));
    fs.writeFileSync(candidate, expected, { mode: 0o600, flag: "wx" });
    const identity = fs.lstatSync(candidate);
    assertUnchanged("before validation");
    validate(candidate);
    const after = fs.lstatSync(candidate);
    if (!after.isFile() || after.ino !== identity.ino || after.dev !== identity.dev ||
        (after.mode & 0o777) !== 0o600 || !fs.readFileSync(candidate).equals(expected)) {
      throw new Error("Config candidate changed during validation; retry with an unchanged candidate");
    }
    assertUnchanged("during validation");
    fs.renameSync(candidate, destination);
  } finally { fs.rmSync(candidate, { force: true }); }
}
