import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export const TESTED_OPENCLAW_VERSION = "2026.9.5";
type Json = Record<string, any>;
const object = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

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
  if (agents.entries && JSON.stringify(agents.entries) !== JSON.stringify(entries)) {
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
    Object.defineProperty(result.agents.entries, id, {
      value: { ...result.agents.entries[id], ...(fields as Json) }, enumerable: true, writable: true, configurable: true,
    });
  }
  if (incoming.agents?.ownership) result.agents.ownership = incoming.agents.ownership;
  // Replace only bindings shipped in the previous baseline; retain unmanaged routing.
  if (incoming.bindings) {
    const old = new Set((base.bindings ?? []).map((b: Json) => JSON.stringify(b)));
    const routes = [...incoming.bindings, ...(live.bindings ?? []).filter((b: Json) => !old.has(JSON.stringify(b)))];
    result.bindings = [...new Map(routes.map((b: Json) => [JSON.stringify(b), b])).values()];
  }
  if (JSON.stringify(result) !== JSON.stringify(incoming)) result._patched = true;
  return result;
}

export function assertSupportedNode(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !(Number(match[1]) === 24 && Number(match[2]) >= 16 || Number(match[1]) >= 26 && (Number(match[1]) > 26 || Number(match[2]) >= 1))) {
    throw new Error("OpenClaw 2026.9.5 requires Node >=24.16.0 <25 or >=26.1.0");
  }
}

/** Target CLI owns full schema/plugin and linked-SQLite validation. No stdout /
 * stderr from candidate validation is surfaced: it can contain secret values. */
export function validateOpenClawCandidate(candidatePath: string): void {
  assertSupportedNode(process.version);
  try {
    const env = { ...process.env, OPENCLAW_CONFIG_PATH: candidatePath,
      OPENCLAW_STATE_DIR: path.dirname(candidatePath), OPENCLAW_CONFIG_READONLY: "1" };
    const version = execFileSync("openclaw", ["--version"], { env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    if (!new RegExp(`(?:^|\\s)${TESTED_OPENCLAW_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`).test(version.trim())) {
      throw new Error("unsupported version");
    }
    execFileSync("openclaw", ["config", "validate", "--json"], {
      env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    throw new Error(`OpenClaw candidate validation failed (tested contract ${TESTED_OPENCLAW_VERSION}); live config unchanged. Check version, plugins and config with the operator's OpenClaw CLI.`);
  }
}

export type ConfigValidator = (candidatePath: string) => void;
/** Exclusive private sibling + rename. Candidate failure never changes live bytes. */
export function publishOpenClawConfig(destination: string, config: Json,
  validate: ConfigValidator = validateOpenClawCandidate): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("Refusing symlink config");
  const previous = fs.existsSync(destination) ? fs.readFileSync(destination) : undefined;
  const candidate = path.join(path.dirname(destination), `.fleetmind-config-${randomUUID()}.json`);
  try {
    const clean = { ...config }; delete clean._patched;
    fs.writeFileSync(candidate, JSON.stringify(clean, null, 2), { mode: 0o600, flag: "wx" });
    validate(candidate);
    const current = fs.existsSync(destination) ? fs.readFileSync(destination) : undefined;
    if ((fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) ||
        (previous ? !current?.equals(previous) : current !== undefined)) {
      throw new Error("Config changed during validation; retry from the current live file");
    }
    fs.renameSync(candidate, destination);
  } finally { fs.rmSync(candidate, { force: true }); }
}
