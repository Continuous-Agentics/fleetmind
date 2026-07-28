/**
 * Normalized fleet model.
 *
 * `normalizeFleet` runs after Zod parse (see config/loader.ts). The wire schema
 * has already branded individual identifier fields; this layer resolves
 * cross-references — every agent's `target` is matched against the `targets`
 * map — and brands the target-map keys. Dangling or missing references fail
 * here, loudly, at load time rather than deep in a deploy.
 */

import os from "node:os";
import path from "node:path";
import type { FleetFile, AgentConfig, TargetConfig } from "../config/schema.js";
import { NatsConfigSchema } from "../config/schema.js";
import { TargetIdId, type TargetId } from "./identifiers.js";

/** A target config with its (branded) map key attached. (Intersection because
 *  TargetConfig is a discriminated union.) */
export type ResolvedTarget = TargetConfig & { id: TargetId };

/**
 * The standard, fixed OS-account home for a target. There is no operator
 * knob for this — every target uses the dedicated `openclaw` account's home
 * (matching the `OPENCLAW_USER`/`OPENCLAW_HOME` bootstrap convention):
 *
 *   - `local`           → `os.homedir()` of the machine running `fleetmind up`
 *     (the operator's own account is the "openclaw" account for local/dev boxes).
 *   - `ssh` / `aws-ssm`  → `/home/openclaw` (Linux) or `/Users/openclaw` (macOS),
 *     selected by `target.os`. This is intentionally not derived from
 *     `ssh.user`/`aws.runtime_user`: those only select which account runs the
 *     systemd/launchd services, not where the dedicated `openclaw` account's
 *     HOME lives.
 */
export function standardHomeDir(target: ResolvedTarget): string {
  if (target.provider === "local") {
    return os.homedir();
  }
  return target.os === "macos" ? "/Users/openclaw" : "/home/openclaw";
}

/** The fixed `openclaw` OS-account home on a Linux (AWS) host —
 *  `/home/openclaw`. Used by bot-side code (e.g. `pull-self`'s legacy
 *  `/etc/fleetmind/agent.env` path) that runs directly on an AWS host and
 *  therefore already knows its target is Linux, without needing a resolved
 *  `Fleet`/`ResolvedTarget` in hand. */
export const STANDARD_AWS_HOME = "/home/openclaw";

/** The fixed per-agent workspace root on a Linux (AWS) host:
 *  `/home/openclaw/.openclaw/workspace`. */
export const STANDARD_AWS_WORKSPACE_BASE = `${STANDARD_AWS_HOME}/.openclaw/workspace`;

/**
 * The fixed, non-configurable workspace root for a target:
 * `<standard-home>/.openclaw/workspace`. FleetMind used to let operators
 * override this via `targets.<id>.workspace_base` in fleet.yaml; that knob
 * is gone — every target now uses the same standard OpenClaw HOME contract
 * with the workspace living directly at this path (one agent per host).
 */
export function standardWorkspaceBase(target: ResolvedTarget): string {
  const home = standardHomeDir(target);
  return target.provider === "local"
    ? path.join(home, ".openclaw", "workspace")
    : path.posix.join(home, ".openclaw", "workspace");
}

/** Fleet config plus resolved accessors. The rest of the codebase consumes
 *  this, not the raw wire object. (Intersection rather than `interface extends`
 *  because FleetFile is a Zod-inferred type with an index signature.) */
export type FleetModel = FleetFile & {
  getAgent(id: string): AgentConfig | undefined;
  readonly orchestrator: AgentConfig | undefined;
  readonly specialists: AgentConfig[];
  /** Targets keyed by their branded id. */
  readonly targetMap: ReadonlyMap<TargetId, ResolvedTarget>;
  /** Resolve the runtime target for an agent: `agent.target` falling back to
   *  `agents.defaults.target`. Throws if neither is set or the reference is
   *  dangling — but normalizeFleet has already validated this for every agent
   *  in `agents.list`, so this only throws for ad-hoc agents. */
  targetForAgent(agent: AgentConfig): ResolvedTarget;
};

/** Back-compat alias — most of the codebase imports this name. */
export type Fleet = FleetModel;

function buildTargetMap(data: FleetFile): Map<TargetId, ResolvedTarget> {
  const map = new Map<TargetId, ResolvedTarget>();
  for (const [key, target] of Object.entries(data.targets)) {
    const id = TargetIdId.parse(key, `targets.${key}`);
    map.set(id, { ...target, id });
  }
  return map;
}

function resolveAgentTargetId(agent: AgentConfig, data: FleetFile): TargetId {
  const id = agent.target ?? data.agents.defaults.target;
  if (!id) {
    throw new Error(
      `Agent "${agent.id}" has no target — set agents.list[].target or agents.defaults.target.`
    );
  }
  return id;
}

/**
 * Auto-default `delegation.nats = {}` when delegation is enabled but no `nats:`
 * block was supplied. NATS is the only supported delegation transport today —
 * `enabled: true` without `nats` is never a valid runtime state (the subscriber
 * exits cleanly, and the publisher refuses to emit). Filling in the empty
 * object lets the existing schema defaults + renderer Cloud-Map URL derivation
 * take over, so operators don't have to write the literal `nats: {}` line.
 *
 * Returns a shallow copy with the patch applied; the input is not mutated.
 */
function applyNatsDefault(data: FleetFile): FleetFile {
  if (!data.delegation?.enabled || data.delegation.nats) {
    return data;
  }
  return {
    ...data,
    delegation: {
      ...data.delegation,
      nats: NatsConfigSchema.parse({}),
    },
  };
}

/** Validate and wrap a parsed fleet file. */
export function normalizeFleet(input: FleetFile): FleetModel {
  const data = applyNatsDefault(input);
  const targetMap = buildTargetMap(data);

  // Eagerly validate every agent resolves to a known target. Collect all
  // problems so the operator sees them in one pass.
  const errors: string[] = [];
  for (const agent of data.agents.list) {
    let targetId: TargetId;
    try {
      targetId = resolveAgentTargetId(agent, data);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    if (!targetMap.has(targetId)) {
      errors.push(
        `Agent "${agent.id}" references target "${targetId}" which is not defined in targets.`
      );
    }
  }
  if (errors.length > 0) {
    const bullets = errors.map((e) => `  - ${e}`).join("\n");
    throw new Error(`Invalid fleet config:\n${bullets}`);
  }

  const targetForAgent = (agent: AgentConfig): ResolvedTarget => {
    const targetId = resolveAgentTargetId(agent, data);
    const target = targetMap.get(targetId);
    if (!target) {
      throw new Error(
        `Agent "${agent.id}" references target "${targetId}" which is not defined in targets.`
      );
    }
    return target;
  };

  return {
    ...data,
    targetMap,
    targetForAgent,
    get orchestrator() {
      return data.agents.list.find((a) => a.orchestrator);
    },
    get specialists() {
      return data.agents.list.filter((a) => !a.orchestrator);
    },
    getAgent(id: string) {
      return data.agents.list.find((a) => a.id === id);
    },
  };
}
