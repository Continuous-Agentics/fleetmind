/**
 * Normalized fleet model.
 *
 * `normalizeFleet` runs after Zod parse (see config/loader.ts). The wire schema
 * has already branded individual identifier fields; this layer resolves
 * cross-references — every agent's `target` is matched against the `targets`
 * map — and brands the target-map keys. Dangling or missing references fail
 * here, loudly, at load time rather than deep in a deploy.
 */

import type { FleetFile, AgentConfig, TargetConfig } from "../config/schema.js";
import { NatsConfigSchema } from "../config/schema.js";
import { TargetIdId, type TargetId } from "./identifiers.js";

/** A target config with its (branded) map key attached. (Intersection because
 *  TargetConfig is a discriminated union.) */
export type ResolvedTarget = TargetConfig & { id: TargetId };

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
