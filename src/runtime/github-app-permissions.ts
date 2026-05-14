/**
 * GitHub App permission resolution for `fleetmind github-app create`.
 *
 * Two layers, merged per-key:
 *   1. Per-bot-type defaults (this module reads
 *      openclaw/<bot-type>/github-app-permissions.yaml).
 *   2. Per-agent override from fleet.yaml's agents.<agent>.github_app block.
 *
 * The per-agent override wins per key (it can add scopes, downgrade scopes,
 * or explicitly drop scopes via `none`). Events are taken from per-agent if
 * present, otherwise fall back to per-bot-type.
 *
 * Manifest format: see openclaw/<bot-type>/github-app-permissions.yaml.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { fleetmindPackageRoot } from "./resolver.js";
import { githubAppPermissionsManifestPath } from "./bot-types.js";
import {
  AgentRoleSchema,
  GitHubAppPermissionLevelSchema,
  type GitHubAppConfig,
  type GitHubAppPermissionLevel,
} from "../config/schema.js";

// ---------------------------------------------------------------------------
// Zod schema for the per-bot-type manifest
// ---------------------------------------------------------------------------

export const GitHubAppPermissionsManifestSchema = z.object({
  role: AgentRoleSchema,
  permissions: z.record(z.string(), GitHubAppPermissionLevelSchema).default({}),
  events: z.array(z.string()).default([]),
});

export type GitHubAppPermissionsManifest = z.infer<typeof GitHubAppPermissionsManifestSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the github-app-permissions.yaml manifest for a given agent role.
 * Returns null if no manifest exists for that role (forward-compat).
 */
export function loadPermissionsManifestForRole(
  role: string,
  packageRoot?: string,
): GitHubAppPermissionsManifest | null {
  const relPath = githubAppPermissionsManifestPath(role);
  if (!relPath) return null;

  const root = packageRoot ?? fleetmindPackageRoot();
  const manifestPath = path.join(root, relPath);
  if (!fs.existsSync(manifestPath)) return null;

  const raw = fs.readFileSync(manifestPath, "utf-8");
  const yamlParsed = parseYaml(raw);

  let parsed: GitHubAppPermissionsManifest;
  try {
    parsed = GitHubAppPermissionsManifestSchema.parse(yamlParsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
      throw new Error(`github-app-permissions.yaml at ${manifestPath} failed validation:\n${issues}`);
    }
    throw err;
  }

  if (parsed.role !== role) {
    throw new Error(
      `github-app-permissions.yaml at ${manifestPath} declares role="${parsed.role}" but expected "${role}".`,
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedGitHubAppConfig {
  /** Final permission set after merging per-bot-type defaults + per-agent
   *  override. Keys with value 'none' are filtered out (those are explicit
   *  drops) — what gets passed to GitHub doesn't include them. */
  permissions: Record<string, Exclude<GitHubAppPermissionLevel, "none">>;
  events: string[];
  /** Where each piece came from, useful for surfacing in CLI output. */
  source: {
    permissionsFromManifest: number;
    permissionsFromOverride: number;
    permissionsDropped: number;
    eventsFrom: "agent" | "manifest" | "none";
  };
}

/**
 * Merge per-bot-type manifest + per-agent override into the final permission
 * set that gets emitted in the GitHub App manifest.
 *
 * Merge semantics:
 *   - Permissions: per-agent wins per key. 'none' explicitly removes a key
 *     from the final set (the operator's way of dropping a default they don't
 *     want).
 *   - Events: per-agent replaces per-bot-type entirely (not merged) — events
 *     are intentional declarations, not partial overrides.
 */
export function resolveGitHubAppConfig(
  role: string,
  agentOverride: GitHubAppConfig | undefined,
  packageRoot?: string,
): ResolvedGitHubAppConfig {
  const manifest = loadPermissionsManifestForRole(role, packageRoot);
  const baseline = manifest?.permissions ?? {};
  const overrides = agentOverride?.permissions ?? {};

  // Start with manifest defaults, apply per-agent overrides.
  const merged: Record<string, GitHubAppPermissionLevel> = { ...baseline, ...overrides };

  // Filter out 'none' values — those are explicit drops.
  const final: Record<string, Exclude<GitHubAppPermissionLevel, "none">> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(merged)) {
    if (value === "none") {
      dropped += 1;
      continue;
    }
    final[key] = value;
  }

  // Events: per-agent replaces per-bot-type entirely.
  let events: string[];
  let eventsFrom: "agent" | "manifest" | "none";
  if (agentOverride?.events && agentOverride.events.length > 0) {
    events = agentOverride.events;
    eventsFrom = "agent";
  } else if (manifest?.events && manifest.events.length > 0) {
    events = manifest.events;
    eventsFrom = "manifest";
  } else {
    events = [];
    eventsFrom = "none";
  }

  // Count where each non-'none' permission came from.
  let permissionsFromOverride = 0;
  let permissionsFromManifest = 0;
  for (const key of Object.keys(final)) {
    if (key in overrides && overrides[key] !== "none") permissionsFromOverride += 1;
    else if (key in baseline) permissionsFromManifest += 1;
  }

  return {
    permissions: final,
    events,
    source: {
      permissionsFromManifest,
      permissionsFromOverride,
      permissionsDropped: dropped,
      eventsFrom,
    },
  };
}
