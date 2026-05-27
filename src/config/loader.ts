/**
 * Fleet config loader — reads fleet.yaml, expands env vars, validates with Zod.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { FleetSchema } from "./schema.js";
import { normalizeFleet, type Fleet } from "../core/model.js";

export type { Fleet } from "../core/model.js";

// ── Fleet source resolution ────────────────────────────────────────────────────

/**
 * Resolve the fleet source from a `--fleet` flag value (or undefined).
 *
 * Resolution order:
 * 1. `--fleet <path>` ends with .yaml/.yml AND file exists → load as file.
 * 2. `--fleet <name>` doesn't end with .yaml → treat as fleet name; build a
 *    minimal Fleet object from environment + naming conventions.
 * 3. No `--fleet` AND /etc/fleetmind/agent.env exists → source it, extract
 *    FLEET_NAME, treat as case 2. (Bot path — bootstrap wrote this file.)
 * 4. No `--fleet` AND /etc/fleetmind/agent.env absent AND fleet.yaml in CWD
 *    → load fleet.yaml from CWD (existing operator-laptop behaviour).
 * 5. Else error.
 *
 * Returns the fleet file path (for cases 1, 4) or a sentinel object path
 * (cases 2, 3 use `buildMinimalFleetFromName` instead of `loadFleet`).
 */
export type FleetSource =
  | { kind: "file"; path: string }
  | { kind: "name"; name: string };

export function resolveFleetSource(flag?: string): FleetSource {
  // Case 1 — explicit file path
  if (flag && (flag.endsWith(".yaml") || flag.endsWith(".yml"))) {
    const abs = path.resolve(flag);
    if (fs.existsSync(abs)) {
      return { kind: "file", path: abs };
    }
    // File path given but doesn't exist — let loadFleet throw a clear error.
    return { kind: "file", path: abs };
  }

  // Case 2 — explicit fleet name (no yaml extension)
  if (flag) {
    return { kind: "name", name: flag };
  }

  // Case 2.5 — FLEET_YAML env var (set in operator shell to avoid passing --fleet every time)
  const envFleet = process.env["FLEET_YAML"];
  if (envFleet) {
    const abs = path.resolve(envFleet);
    return { kind: "file", path: abs };
  }

  // Case 3 — bot path: /etc/fleetmind/agent.env
  const agentEnvPath = "/etc/fleetmind/agent.env";
  if (fs.existsSync(agentEnvPath)) {
    const envText = fs.readFileSync(agentEnvPath, "utf-8");
    const nameMatch = envText.match(/^FLEET_NAME=(.+)$/m);
    if (!nameMatch?.[1]) {
      throw new Error(
        `Found ${agentEnvPath} but it does not contain FLEET_NAME. ` +
          "Check your bootstrap configuration."
      );
    }
    // On bot instances, WORKSPACE_BASE and AGENT_ID are always present.
    // The workspace fleet.yaml is the full config (includes NATS, Slack, etc).
    // The minimal name-based config only has DDB — never use it on instances.
    const wsBaseMatch = envText.match(/^WORKSPACE_BASE=(.+)$/m);
    const agentIdMatch = envText.match(/^AGENT_ID=(.+)$/m);
    if (wsBaseMatch?.[1] && agentIdMatch?.[1]) {
      const wsFleet = path.join(
        wsBaseMatch[1].trim(),
        agentIdMatch[1].trim(),
        "fleet.yaml"
      );
      if (fs.existsSync(wsFleet)) {
        return { kind: "file", path: wsFleet };
      }
      throw new Error(
        `Bot instance has WORKSPACE_BASE + AGENT_ID in ${agentEnvPath} but ` +
          `workspace fleet.yaml not found at ${wsFleet}. ` +
          `Run 'fleetmind push fleet' to deploy the workspace.`
      );
    }
    // Operator machine: no workspace, use minimal name-based config.
    return { kind: "name", name: nameMatch[1].trim() };
  }

  // Case 4 — fleet.yaml in CWD
  const cwdFleet = path.resolve("fleet.yaml");
  if (fs.existsSync(cwdFleet)) {
    return { kind: "file", path: cwdFleet };
  }

  // Case 5 — nothing found
  throw new Error(
    "Couldn't resolve fleet — pass --fleet <path-or-name>, or run from a " +
      "directory with fleet.yaml, or on a host with /etc/fleetmind/agent.env."
  );
}

/**
 * Build a minimal Fleet object from a fleet name.
 * Used when the fleet is identified by name (cases 2, 3 of resolveFleetSource).
 */
export function buildMinimalFleet(name: string): Fleet {
  const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-west-2";
  // Construct a minimal Fleet that satisfies the Fleet interface.
  // Only the delegation sub-section is needed for narrative/query/task commands.
  const minimalData = {
    fleet: { name },
    agents: { list: [] },
    delegation: {
      enabled: true,
      table_name: `${name}-tasks`,
      s3_bucket: `${name}-ledger`,
      aws_region: region,
      s3_key_template: "v0/projects/{project}/tasks/{date}-{task_id}.md",
    },
  };

  const result = FleetSchema.safeParse(minimalData);
  if (!result.success) {
    // Shouldn't happen with valid fleet name, but handle gracefully.
    throw new Error(
      `Failed to build minimal fleet for name '${name}': ` +
        result.error.issues.map((i) => i.message).join("; ")
    );
  }

  return normalizeFleet(result.data);
}

/**
 * Resolve and load a fleet. Accepts a FleetSource (from resolveFleetSource)
 * or a raw `--fleet` flag string.
 *
 * This is the single call-site for all CLI commands.
 */
export function resolveAndLoadFleet(flag?: string): Fleet {
  const source = resolveFleetSource(flag);
  if (source.kind === "name") {
    return buildMinimalFleet(source.name);
  }
  return loadFleet(source.path);
}

/** Recursively expand ${VAR} in strings */
function expandEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? `\${${key}}`);
  }
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, expandEnv(v)])
    );
  }
  return obj;
}

export function loadFleet(filePath: string): Fleet {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Fleet file not found: ${abs}`);
  }

  const raw = fs.readFileSync(abs, "utf-8");
  const parsed = yaml.load(raw);
  const expanded = expandEnv(parsed);

  const result = FleetSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid fleet.yaml:\n${issues}`);
  }

  return normalizeFleet(result.data);
}
