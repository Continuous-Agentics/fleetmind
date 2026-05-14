/**
 * Single source of truth for agent role → bot-type directory mapping.
 *
 * The fleetmind package ships a directory per bot type under `openclaw/`,
 * each containing a `workspace/` subdir (bundle of AGENTS.md / SOUL.md /
 * IDENTITY.md / PATCHES.md) and a `skills.yaml` manifest. Several modules
 * need to map from an agent's `role` (as declared in fleet.yaml) to the
 * corresponding bot-type dir:
 *
 *   - provisioner.ts        → reads `<bot-type>/workspace/` to build per-agent workspaces
 *   - skills-manifest.ts    → reads `<bot-type>/skills.yaml`
 *   - render.ts             → logs the source-of-truth manifest path
 *
 * Keep the mapping here. Adding a new role (e.g. `infra-monitor`) requires
 * updating exactly this map.
 */

import type { AgentRole } from "../config/schema.js";

/** Map agent role → bot-type directory name (relative to `openclaw/`). */
export const ROLE_TO_BOT_TYPE: Record<AgentRole, string> = {
  "pm": "pm-bot",
  "backend-worker": "backend-worker-bot",
  "frontend-worker": "frontend-worker-bot",
  "worker": "worker-bot",
};

/**
 * Return the bot-type dir name for a given role, or null when the role isn't
 * mapped (forward-compat for new roles before their directory ships).
 */
export function botTypeForRole(role: string): string | null {
  return ROLE_TO_BOT_TYPE[role as AgentRole] ?? null;
}

/**
 * Path of the workspace template dir relative to the package root.
 * Used by provisioner.ts.
 */
export function workspaceTemplatePath(role: string): string | null {
  const botType = botTypeForRole(role);
  return botType ? `openclaw/${botType}/workspace` : null;
}

/**
 * Path of the skills.yaml manifest relative to the package root.
 * Used by skills-manifest.ts and the render log message.
 */
export function skillsManifestPath(role: string): string | null {
  const botType = botTypeForRole(role);
  return botType ? `openclaw/${botType}/skills.yaml` : null;
}
