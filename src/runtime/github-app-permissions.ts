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
// Known GitHub App permission scopes (best-effort, warn-not-fail validation)
// ---------------------------------------------------------------------------

/**
 * Best-effort list of documented GitHub App permission scope names.
 * Used by resolveGitHubAppConfig to warn (NOT fail) when a permission key
 * doesn't look like a real scope — catches typos like `contens: write` before
 * the manifest reaches GitHub.
 *
 * GitHub adds scopes occasionally; an unknown key here doesn't mean it's
 * invalid — just that we don't recognize it. The warning helps operators
 * catch typos in their fleet.yaml without locking out new scopes.
 *
 * Source: https://docs.github.com/en/apps/creating-github-apps/setting-permissions-for-github-apps
 */
const KNOWN_GITHUB_PERMISSION_KEYS = new Set([
  // Repository scopes
  "actions", "administration", "attestations", "checks", "codespaces",
  "codespaces_lifecycle_admin", "codespaces_metadata", "codespaces_secrets",
  "contents", "dependabot_secrets", "deployments", "discussions", "environments",
  "issues", "members", "merge_queues", "metadata", "packages", "pages",
  "pull_requests", "repository_advisories", "repository_custom_properties",
  "repository_hooks", "repository_projects", "secret_scanning_alerts",
  "secrets", "security_events", "single_file", "statuses", "variables",
  "vulnerability_alerts", "workflows",
  // Organization scopes
  "organization_administration", "organization_announcement_banners",
  "organization_codespaces", "organization_codespaces_secrets",
  "organization_codespaces_settings", "organization_copilot_seat_management",
  "organization_custom_org_roles", "organization_custom_properties",
  "organization_custom_roles", "organization_events", "organization_hooks",
  "organization_packages", "organization_personal_access_token_requests",
  "organization_personal_access_tokens", "organization_plan",
  "organization_projects", "organization_secrets",
  "organization_self_hosted_runners", "organization_user_blocking",
  // Account scopes (less common in this context)
  "blocking", "email_addresses", "followers", "gpg_keys", "interaction_limits",
  "keys", "profile", "starring", "watching",
]);

/** Returns the subset of the input keys that aren't in the known-scopes set. */
export function findUnknownPermissionKeys(permissions: Record<string, unknown>): string[] {
  return Object.keys(permissions).filter((k) => !KNOWN_GITHUB_PERMISSION_KEYS.has(k));
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
    /** Permission keys not in the bundled known-scopes list. May be typos or
     *  newer GitHub scopes the bundled list hasn't been updated to know about. */
    unknownKeys: string[];
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
    events = [...new Set(agentOverride.events)];
    eventsFrom = "agent";
  } else if (manifest?.events && manifest.events.length > 0) {
    events = [...new Set(manifest.events)];
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

  // Warn on unknown permission keys — catches typos like `contens: write`
  // before the manifest reaches GitHub. Don't fail — GitHub adds scopes
  // occasionally and we don't want to block valid-but-new keys.
  const unknown = findUnknownPermissionKeys(merged);
  if (unknown.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[github-app-permissions] Unknown permission key${unknown.length === 1 ? "" : "s"} ` +
        `(not in the bundled known-scopes list — may be a typo or a newer GitHub scope): ${unknown.join(", ")}`,
    );
  }

  return {
    permissions: final,
    events,
    source: {
      permissionsFromManifest,
      permissionsFromOverride,
      permissionsDropped: dropped,
      eventsFrom,
      unknownKeys: unknown,
    },
  };
}
