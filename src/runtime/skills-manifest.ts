/**
 * Skills manifest resolver.
 *
 * Each bot-type directory under `openclaw/` ships a `skills.yaml` declaring the
 * skills required for that bot type. This module reads those manifests and
 * computes "what required skills is a given agent missing?" — used by both
 * `fleetmind doctor` (read-only report) and `fleetmind render` (auto-inject).
 *
 * The manifest is *data*: the renderer doesn't read it at render time except
 * to drive the optional pre-render injection step. Operators see exactly what's
 * in their fleet.yaml after the injection runs.
 *
 * Manifest format: see `openclaw/SKILLS-MANIFEST.md` in the package root.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { fleetmindPackageRoot } from "./resolver.js";
import type { SkillRef, SkillSource } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Role → bot-type directory mapping
// ---------------------------------------------------------------------------

/**
 * Map agent `role` (from the schema enum) to the bot-type directory under
 * `openclaw/`. Mirrors `ROLE_TEMPLATE_DIR` in provisioner.ts so a single
 * convention drives both workspace bundling and skill manifests.
 */
const ROLE_TO_BOT_TYPE: Record<string, string> = {
  "pm": "pm-bot",
  "backend-worker": "backend-worker-bot",
  "frontend-worker": "frontend-worker-bot",
  "worker": "worker-bot",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillManifest {
  role: string;
  required: SkillRef[];
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Load the skills.yaml manifest for a given agent role.
 *
 * Returns null if no manifest exists for that role (forward-compat: a role
 * can appear in the schema enum without a manifest yet; doctor/render simply
 * skip that agent in that case).
 */
export function loadManifestForRole(role: string, packageRoot?: string): SkillManifest | null {
  const botType = ROLE_TO_BOT_TYPE[role];
  if (!botType) return null;

  const root = packageRoot ?? fleetmindPackageRoot();
  const manifestPath = path.join(root, "openclaw", botType, "skills.yaml");
  if (!fs.existsSync(manifestPath)) return null;

  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = parseYaml(raw) as Partial<SkillManifest> | null;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`skills.yaml at ${manifestPath} is empty or invalid`);
  }
  if (parsed.role !== role) {
    throw new Error(
      `skills.yaml at ${manifestPath} declares role="${parsed.role}" but expected "${role}". ` +
        `Each bot-type's manifest must declare a role that matches its directory.`,
    );
  }

  // YAML parses commented-out list entries as absent (not as null).
  // Still, defensively filter any null/undefined that may sneak in.
  const required = Array.isArray(parsed.required)
    ? parsed.required.filter((s): s is SkillRef => s != null && typeof s === "object" && typeof (s as SkillRef).name === "string")
    : [];

  return {
    role: parsed.role,
    required: required.map(normalizeSkillRef),
  };
}

/**
 * Normalize a skill entry from the manifest into a fully-shaped SkillRef.
 * Default source is "fleetmind" for manifest entries — different from the
 * fleet.yaml shorthand default ("client") because the manifest is opinionated
 * about where bundled skills come from.
 */
function normalizeSkillRef(raw: SkillRef): SkillRef {
  return {
    name: raw.name,
    source: (raw.source ?? "fleetmind") as SkillSource,
    author: raw.author,
    version: raw.version,
  };
}

// ---------------------------------------------------------------------------
// Diff: which required skills is this agent missing?
// ---------------------------------------------------------------------------

/**
 * Given an agent's declared skills and the manifest for its role, return the
 * required skills that are not yet declared on the agent.
 *
 * Matching is by skill `name` — version/source/author differences do not
 * trigger re-add. This is intentional: operators can pin a specific version
 * of a required skill and the manifest won't fight them.
 */
export function findMissingRequiredSkills(
  agentSkills: ReadonlyArray<{ name: string }>,
  manifest: SkillManifest,
): SkillRef[] {
  const declared = new Set(agentSkills.map((s) => s.name));
  return manifest.required.filter((s) => !declared.has(s.name));
}

// ---------------------------------------------------------------------------
// Convenience: per-agent diff across an entire fleet
// ---------------------------------------------------------------------------

export interface AgentSkillGap {
  agentId: string;
  role: string;
  /** null when no manifest exists for this role (skipped). */
  manifest: SkillManifest | null;
  missing: SkillRef[];
}

export function computeFleetSkillGaps(
  agents: ReadonlyArray<{ id: string; role?: string; skills?: ReadonlyArray<{ name: string }> }>,
  packageRoot?: string,
): AgentSkillGap[] {
  return agents.map((agent) => {
    const role = agent.role ?? "worker";
    const manifest = loadManifestForRole(role, packageRoot);
    const missing = manifest ? findMissingRequiredSkills(agent.skills ?? [], manifest) : [];
    return { agentId: agent.id, role, manifest, missing };
  });
}
