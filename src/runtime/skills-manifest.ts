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
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { fleetmindPackageRoot } from "./resolver.js";
import { skillsManifestPath } from "./bot-types.js";
import { AgentRoleSchema, SkillSourceSchema, type SkillRef } from "../config/schema.js";
import { SkillNameSchema } from "../core/identifiers.js";

// ---------------------------------------------------------------------------
// Zod schema for skills.yaml
// ---------------------------------------------------------------------------

/** One entry in the manifest's `required` list. */
const ManifestSkillEntrySchema = z.object({
  name: SkillNameSchema,
  /** Defaults to "fleetmind" for manifest entries (different from fleet.yaml's
   * shorthand default of "client" — manifests are opinionated about bundled
   * origins). */
  source: SkillSourceSchema.removeDefault().default("fleetmind"),
  /** Required only when source is "clawhub". Not currently enforced at schema
   * layer because some `private` skills also use author paths; relax for now. */
  author: z.string().optional(),
  version: z.string().optional(),
  /** Optional fleet feature gate. Omitted entries are always required. */
  when: z.enum(["delegation-enabled"]).optional(),
}).strict();

export const SkillManifestSchema = z.object({
  role: AgentRoleSchema,
  /** Required skill set. Commented-out entries are absent at YAML-parse time;
   * any nulls that slip through are filtered by ManifestSkillEntrySchema's
   * object constraint. */
  required: z.array(ManifestSkillEntrySchema).default([]),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type ManifestPolicy = { delegationEnabled: boolean };

/** Defaulting to enabled preserves the original public helper semantics for
 * callers that do not have fleet context (for example template scaffolding). */
const DEFAULT_MANIFEST_POLICY: ManifestPolicy = { delegationEnabled: true };

/** Requirements active for the current fleet policy, stripped to fleet.yaml's
 * SkillRef shape so manifest-only condition metadata is never injected. */
export function activeRequiredSkills(
  manifest: SkillManifest,
  policy: ManifestPolicy = DEFAULT_MANIFEST_POLICY,
): SkillRef[] {
  return manifest.required
    .filter((entry) => entry.when !== "delegation-enabled" || policy.delegationEnabled)
    .map(({ name, source, author, version }) => ({ name, source, author, version }));
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
 *
 * Throws if the manifest exists but is malformed (invalid YAML, missing role,
 * role mismatch, unknown skill source, etc.) — with Zod-shaped errors that
 * point at the offending field.
 */
export function loadManifestForRole(role: string, packageRoot?: string): SkillManifest | null {
  const relPath = skillsManifestPath(role);
  if (!relPath) return null;

  const root = packageRoot ?? fleetmindPackageRoot();
  const manifestPath = path.join(root, relPath);
  if (!fs.existsSync(manifestPath)) return null;

  const raw = fs.readFileSync(manifestPath, "utf-8");
  const yamlParsed = parseYaml(raw);

  let parsed: SkillManifest;
  try {
    parsed = SkillManifestSchema.parse(yamlParsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
      throw new Error(`skills.yaml at ${manifestPath} failed validation:\n${issues}`);
    }
    throw err;
  }

  if (parsed.role !== role) {
    throw new Error(
      `skills.yaml at ${manifestPath} declares role="${parsed.role}" but expected "${role}". ` +
        `Each bot-type's manifest must declare a role that matches its directory.`,
    );
  }

  return parsed;
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
  policy: ManifestPolicy = DEFAULT_MANIFEST_POLICY,
): SkillRef[] {
  const declared = new Set(agentSkills.map((s) => s.name));
  return activeRequiredSkills(manifest, policy).filter((s) => !declared.has(s.name));
}

// ---------------------------------------------------------------------------
// Convenience: per-agent diff across an entire fleet
// ---------------------------------------------------------------------------

export interface AgentSkillGap {
  agentId: string;
  role: string;
  /** null when no manifest exists for this role (skipped). */
  manifest: SkillManifest | null;
  /** Requirements active under this fleet's manifest policy. */
  activeRequired: SkillRef[];
  missing: SkillRef[];
  sourceMismatches: SourceMismatch[];
}

export function computeFleetSkillGaps(
  agents: ReadonlyArray<{ id: string; role?: string; skills?: ReadonlyArray<SkillRef | { name: string; source?: string }> }>,
  packageRoot?: string,
  policy: ManifestPolicy = DEFAULT_MANIFEST_POLICY,
): AgentSkillGap[] {
  return agents.map((agent) => {
    const role = agent.role ?? "worker";
    const manifest = loadManifestForRole(role, packageRoot);
    const activeRequired = manifest ? activeRequiredSkills(manifest, policy) : [];
    const missing = manifest ? findMissingRequiredSkills(agent.skills ?? [], manifest, policy) : [];
    const sourceMismatches = manifest ? findSourceMismatches(agent.skills ?? [], manifest, policy) : [];
    return { agentId: agent.id, role, manifest, activeRequired, missing, sourceMismatches };
  });
}

/** Fleet-aware entry point used by both render and doctor. Keeping feature
 * policy here prevents either command from accidentally checking all static
 * manifest entries without considering delegation.enabled. */
export function computeConfiguredFleetSkillGaps(
  fleet: {
    delegation?: { enabled: boolean };
    agents: { list: ReadonlyArray<{ id: string; role?: string; skills?: ReadonlyArray<SkillRef | { name: string; source?: string }> }> };
  },
  packageRoot?: string,
): AgentSkillGap[] {
  return computeFleetSkillGaps(fleet.agents.list, packageRoot, {
    delegationEnabled: fleet.delegation?.enabled === true,
  });
}

/**
 * For each required skill that's present-by-name but declared with a different
 * source than the manifest expects, return a diagnostic record. Used by doctor
 * to warn (without re-injecting — operator explicit declarations win).
 */
export interface SourceMismatch {
  skillName: string;
  declaredSource: string;
  manifestSource: string;
}

export function findSourceMismatches(
  agentSkills: ReadonlyArray<{ name: string; source?: string }>,
  manifest: SkillManifest,
  policy: ManifestPolicy = DEFAULT_MANIFEST_POLICY,
): SourceMismatch[] {
  const mismatches: SourceMismatch[] = [];
  for (const req of activeRequiredSkills(manifest, policy)) {
    const declared = agentSkills.find((s) => s.name === req.name);
    if (!declared) continue; // it's a gap, not a mismatch — covered by findMissingRequiredSkills
    const declaredSource = declared.source ?? "client";
    if (declaredSource !== req.source) {
      mismatches.push({ skillName: req.name, declaredSource, manifestSource: req.source });
    }
  }
  return mismatches;
}
