/**
 * Fleet config loader — reads fleet.yaml, expands env vars, validates with Zod.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { FleetSchema, type Fleet, type AgentConfig } from "./schema.js";

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

  const data = result.data;

  // Attach helper methods
  const fleet: Fleet = {
    ...data,
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

  return fleet;
}
