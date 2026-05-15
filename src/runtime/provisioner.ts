/**
 * FleetMind provisioner — creates agent workspaces and installs skills.
 *
 * Skills are resolved via the three-tier resolver:
 *   clawhub → public ClaWHub/GitHub skill
 *   private → Continuous Agentics private registry (GitHub Packages)
 *   client  → client's own skills_repo (default)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Fleet, AgentConfig, CronSweepConfig } from "../config/schema.js";
import { installSkill } from "./resolver.js";
import { log } from "../utils/log.js";
import { workspaceTemplatePath } from "./bot-types.js";

// =============================================================================
// Role-template resolution
// =============================================================================

// =============================================================================
// Fleet roster helpers
// =============================================================================

const ROLE_LABELS: Record<string, string> = {
  "pm": "PM (orchestrator)",
  "backend-worker": "Backend worker",
  "frontend-worker": "Frontend worker",
  "worker": "Worker",
};

function roleLabel(role: string | undefined): string {
  return ROLE_LABELS[role ?? "worker"] ?? "Worker";
}

/**
 * Generate the `## Fleet Members` markdown section for a given agent.
 * Lists all other agents in the fleet (not self).
 */
export function buildFleetRoster(fleet: Fleet, currentAgent: AgentConfig): string {
  const peers = fleet.agents.list.filter((a) => a.id !== currentAgent.id);

  if (peers.length === 0) {
    return [
      "## Fleet Members",
      "",
      `You are a solo bot in the **${fleet.fleet.name}** fleet. No peer bots configured today.`,
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "## Fleet Members",
    "",
    `You are part of the **${fleet.fleet.name}** fleet. Your peers:`,
    "",
  ];

  for (const peer of peers) {
    const userId = peer.slack?.bot_user_id ?? "TODO (run fleetmind slack discover)";
    const channels = (peer.slack?.channels ?? []).join(", ") || "(none configured)";
    const label = roleLabel(peer.role);
    lines.push(`- **${peer.name}** (${peer.emoji ?? ""}) — ${peer.description ?? ""}`);
    lines.push(`  - Slack user: \`${userId}\` (mention: \`<@${userId}>\`)`);
    lines.push(`  - Operates in: ${channels}`);
    lines.push(`  - Role: ${label}`);
    lines.push("");
  }

  lines.push("Use this roster when delegating, replying, or coordinating across channels.");
  lines.push("");

  return lines.join("\n");
}

function applyPlaceholders(text: string, agent: AgentConfig, fleet?: Fleet): string {
  let result = text
    .replaceAll("{{NAME}}", agent.name)
    .replaceAll("{{EMOJI}}", agent.emoji ?? "")
    .replaceAll("{{DESCRIPTION}}", agent.description ?? "")
    .replaceAll("{{SOUL_BODY}}", agent.persona?.soul ?? "");

  if (fleet !== undefined) {
    result = result.replaceAll("{{FLEET_ROSTER}}", buildFleetRoster(fleet, agent));
  }

  return result;
}

function readRoleTemplate(role: string, filename: string): string | null {
  const dir = workspaceTemplatePath(role) ?? workspaceTemplatePath("worker")!;
  const filePath = path.resolve(process.cwd(), dir, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

// =============================================================================
// Workspace file generators
// =============================================================================

function soulMd(agent: AgentConfig): string {
  return `# SOUL.md — ${agent.name}\n\n${agent.persona.soul}\n`;
}

function agentsMd(agent: AgentConfig): string {
  const role = agent.orchestrator
    ? "Orchestrator: coordinates the fleet and delegates to specialist agents."
    : "Specialist: handles delegated tasks from the orchestrator.";
  return `# AGENTS.md — ${agent.name} (${agent.emoji})\n\n${agent.description}\n\n## Role\n\n${role}\n\n## Memory\n\n- Daily notes: \`memory/YYYY-MM-DD.md\`\n- Long-term: \`MEMORY.md\`\n\n## Tools\n\nSkills define available tools. Check TOOLS.md for environment-specific notes.\n`;
}

function identityMd(agent: AgentConfig): string {
  const role = agent.orchestrator ? "Orchestrator" : "Specialist";
  return `# IDENTITY.md\n\n- **Name:** ${agent.name}\n- **Emoji:** ${agent.emoji}\n- **Role:** ${role}\n- **Description:** ${agent.description}\n`;
}

const USER_MD = `# USER.md — About Your Human\n\n_Populated during onboarding._\n\n- **Name:**\n- **Timezone:**\n- **Notes:**\n`;

function writeFile(filePath: string, content: string, dryRun: boolean): void {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

// =============================================================================
// Cron sweep seeding
// =============================================================================

/** Minimal shape of OpenClaw's ~/.openclaw/cron/jobs.json */
interface CronJobsFile {
  version: number;
  jobs: CronJob[];
}

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  createdAtMs: number;
  description?: string;
  schedule:
    | { kind: "every"; every: string }
    | { kind: "cron"; expr: string; tz?: string };
  sessionTarget: "isolated";
  wakeMode: "now";
  payload: { kind: "agentTurn"; message: string; model: string };
  delivery: { mode: "none" };
  state: Record<string, unknown>;
}

/**
 * Derive a stable, deterministic job ID from fleet + agent + sweep name.
 *
 * Uses SHA-256 so the same inputs always produce the same UUID-shaped string.
 * This ensures re-deploying to a fresh instance produces the same job ID,
 * keeping run history coherent. `fleetmind diff` can also detect renames
 * (old name present in jobs.json + new name absent = pending update).
 */
export function sweepJobId(fleetName: string, agentId: string, sweepName: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`fleetmind:sweep:${fleetName}:${agentId}:${sweepName}`)
    .digest("hex");
  // Format as UUID v4 shape with variant bits set. Not a true RFC 4122 v4 but
  // stable, collision-resistant, and recognisable in `openclaw cron list`.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${((parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function buildSweepJob(
  fleetName: string,
  agentId: string,
  sweep: CronSweepConfig
): CronJob {
  const schedule: CronJob["schedule"] = sweep.every
    ? { kind: "every", every: sweep.every }
    : { kind: "cron", expr: sweep.cron_expr!, ...(sweep.tz ? { tz: sweep.tz } : {}) };

  return {
    id: sweepJobId(fleetName, agentId, sweep.name),
    name: sweep.name,
    enabled: true,
    createdAtMs: Date.now(),
    ...(sweep.description ? { description: sweep.description } : {}),
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: `WORKER_SWEEP: ${sweep.worker_id}`,
      // Fall back to "haiku" defensively in case the object bypasses Zod defaults.
      model: sweep.model ?? "haiku",
    },
    delivery: { mode: "none" },
    state: {},
  };
}

/**
 * Idempotently seed `WORKER_SWEEP` cron jobs into the PM bot's OpenClaw cron
 * scheduler (`~/.openclaw/cron/jobs.json`).
 *
 * - Only runs for PM bots (`agent.orchestrator === true`).
 * - Reads existing jobs.json if present; skips any sweep whose `name` is
 *   already registered. Checking by name (not ID) means a manual
 *   `openclaw cron edit` to the schedule persists across re-deploys.
 * - New sweeps are appended and the file is written atomically (write to .tmp,
 *   then rename) to avoid corrupting a running gateway's hot-reload read.
 * - The OpenClaw gateway hot-reloads jobs.json on write, so no restart needed.
 */
async function seedCronSweeps(
  fleet: Fleet,
  agent: AgentConfig,
  dryRun: boolean,
  /** Same localBase as provisionAgent — cron output goes to <localBase>/rendered/cron/. */
  localBase: string
): Promise<void> {
  if (!agent.orchestrator) return;
  const sweeps = agent.delegation?.sweeps;
  if (!sweeps?.length) return;

  // Cron sweeps are written locally to ./rendered/cron/jobs.json so the
  // rendered output can be SCP'd to workspace_base/cron/ on the EC2.
  // We do NOT use workspace_base as a local mkdir target.
  const cronDir = path.join(localBase, "rendered", "cron");
  const jobsPath = path.join(cronDir, "jobs.json");
  const tmpPath = `${jobsPath}.tmp`;

  // Load existing jobs.json (graceful on missing or malformed file).
  let existing: CronJobsFile = { version: 1, jobs: [] };
  if (fs.existsSync(jobsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as CronJobsFile;
    } catch {
      log.warn(`  Warning: could not parse ${jobsPath} — will append to a fresh file`);
    }
  }

  const existingNames = new Set(existing.jobs.map((j) => j.name));
  const toAdd: CronJob[] = [];

  for (const sweep of sweeps) {
    if (existingNames.has(sweep.name)) {
      log.info(`    sweep '${sweep.name}' already registered — skipping`);
    } else {
      toAdd.push(buildSweepJob(fleet.fleet.name, agent.id, sweep));
      const schedule = sweep.every ? `every ${sweep.every}` : sweep.cron_expr!;
      log.info(
        `    sweep '${sweep.name}' → WORKER_SWEEP: ${sweep.worker_id} (${schedule}, model=${sweep.model})`
      );
    }
  }

  if (toAdd.length === 0) return;

  if (!dryRun) {
    fs.mkdirSync(cronDir, { recursive: true });
    const updated: CronJobsFile = {
      version: existing.version,
      jobs: [...existing.jobs, ...toAdd],
    };
    // Atomic write: write to .tmp then rename, so the gateway never reads a
    // partially-written file during its hot-reload path.
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, jobsPath);
  }
}

// =============================================================================
// Public API
// =============================================================================

export async function provisionAgent(
  fleet: Fleet,
  agent: AgentConfig,
  dryRun: boolean,
  /** Local base directory for rendered output. Defaults to process.cwd().
   *  Workspace files are written to <localBase>/rendered/workspaces/<agent_id>/.
   *  workspace_base from fleet config is the EC2-side path; it is NOT used as a
   *  local mkdir target. */
  localBase: string = process.cwd()
): Promise<void> {
  // Local render target: ./rendered/workspaces/<agent_id>/ — consistent with
  // openclaw_json and terraform_vars which both go to ./rendered/.
  // workspace_base remains the EC2-side path (consumed by user-data and the
  // future deploy transport); it must NOT be used as a local mkdir target.
  const workspace = path.join(localBase, "rendered", "workspaces", agent.id);

  if (!dryRun) fs.mkdirSync(workspace, { recursive: true });

  const role = agent.role ?? "worker";

  const soulTemplate = readRoleTemplate(role, "SOUL.md");
  const soulContent = soulTemplate !== null
    ? applyPlaceholders(soulTemplate, agent, fleet)
    : soulMd(agent);
  writeFile(path.join(workspace, "SOUL.md"), soulContent, dryRun);

  const agentsTemplate = readRoleTemplate(role, "AGENTS.md");
  const agentsContent = agentsTemplate !== null
    ? applyPlaceholders(agentsTemplate, agent, fleet)
    : agentsMd(agent);
  writeFile(path.join(workspace, "AGENTS.md"), agentsContent, dryRun);

  const identityTemplate = readRoleTemplate(role, "IDENTITY.md");
  const identityContent = identityTemplate !== null
    ? applyPlaceholders(identityTemplate, agent, fleet)
    : identityMd(agent);
  writeFile(path.join(workspace, "IDENTITY.md"), identityContent, dryRun);

  // HEARTBEAT.md — operator-scaffolded, bots add task sections. Always ship
  // so pull-self's section merge can update the AUTO-tagged operator sections
  // while preserving bot-added task sections.
  const heartbeatTemplate = readRoleTemplate(role, "HEARTBEAT.md");
  if (heartbeatTemplate !== null) {
    writeFile(path.join(workspace, "HEARTBEAT.md"), heartbeatTemplate, dryRun);
  }

  // PATCHES.md — shipped to agent workspace so pull-self can apply patches
  // after each workspace update (see runtime/patch-engine.ts).
  const patchesTemplate = readRoleTemplate(role, "PATCHES.md");
  if (patchesTemplate !== null) {
    writeFile(path.join(workspace, "PATCHES.md"), patchesTemplate, dryRun);
  }

  // USER.md — only create if missing (don't overwrite customized versions)
  const userMdPath = path.join(workspace, "USER.md");
  if (!fs.existsSync(userMdPath)) {
    writeFile(userMdPath, USER_MD, dryRun);
  }

  // Install skills via three-tier resolver
  if (agent.skills.length > 0) {
    const skillsDir = path.join(workspace, "skills");
    if (!dryRun) fs.mkdirSync(skillsDir, { recursive: true });

    for (const skill of agent.skills) {
      await installSkill(skill, skillsDir, fleet, dryRun);
    }
  }

  log.dim(`  workspace → ${workspace}`);

  // Seed WORKER_SWEEP cron jobs into jobs.json for PM bots.
  await seedCronSweeps(fleet, agent, dryRun, localBase);
}

export async function provisionFleet(
  fleet: Fleet,
  dryRun = false,
  /** Local base directory for rendered output. Defaults to process.cwd(). */
  localBase: string = process.cwd()
): Promise<void> {
  log.info(`\nFleetMind — provisioning fleet ${fleet.fleet.name}`);
  if (fleet.fleet.client) log.info(`  Client: ${fleet.fleet.client}`);
  log.info(`  Agents: ${fleet.agents.list.length}`);
  if (dryRun) log.warn("  Dry run — no changes will be made\n");

  for (const agent of fleet.agents.list) {
    log.step(`${agent.emoji} ${agent.name}...`);
    await provisionAgent(fleet, agent, dryRun, localBase);
    log.ok(`${agent.emoji} ${agent.name}`);
  }

  log.success("\nFleet provisioned.");
  log.info(`  Workspaces written to ${path.join(localBase, "rendered", "workspaces")}/`);
  log.info("  Next: run `fleetmind render` to generate openclaw.json");
}

export function diffFleet(
  fleet: Fleet,
  /** Local base directory for rendered output. Defaults to process.cwd(). */
  localBase: string = process.cwd()
): string[] {
  const changes: string[] = [];

  for (const agent of fleet.agents.list) {
    const workspace = path.join(localBase, "rendered", "workspaces", agent.id);

    if (!fs.existsSync(workspace)) {
      changes.push(`[+] Create workspace for ${agent.emoji} ${agent.name} at ${workspace}`);
      continue;
    }

    const soulPath = path.join(workspace, "SOUL.md");
    if (!fs.existsSync(soulPath)) {
      changes.push(`[+] ${agent.name}: create SOUL.md`);
    } else {
      const current = fs.readFileSync(soulPath, "utf-8").trim();
      const expected = soulMd(agent).trim();
      if (current !== expected) changes.push(`[~] ${agent.name}: update SOUL.md`);
    }

    const skillsDir = path.join(workspace, "skills");
    for (const skill of agent.skills) {
      const skillPath = path.join(skillsDir, skill.name);
      if (!fs.existsSync(skillPath)) {
        const source = skill.source ?? "client";
        const ver = skill.version ? `@${skill.version}` : "@latest";
        changes.push(`[+] ${agent.name}: install skill ${skill.name}${ver} (${source})`);
      }
    }

    // Cron sweeps diff — report any new sweeps that haven't been seeded yet.
    if (agent.orchestrator && agent.delegation?.sweeps?.length) {
      const cronDir = path.join(localBase, "rendered", "cron");
      const jobsPath = path.join(cronDir, "jobs.json");
      let existingNames = new Set<string>();
      if (fs.existsSync(jobsPath)) {
        try {
          const f = JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as CronJobsFile;
          existingNames = new Set(f.jobs.map((j) => j.name));
        } catch { /* ignore */ }
      }
      for (const sweep of agent.delegation.sweeps) {
        if (!existingNames.has(sweep.name)) {
          const schedule = sweep.every ? `every ${sweep.every}` : sweep.cron_expr!;
          changes.push(
            `[+] ${agent.name}: seed cron sweep '${sweep.name}' → WORKER_SWEEP: ${sweep.worker_id} (${schedule})`
          );
        }
      }
    }
  }

  return changes.length > 0 ? changes : ["No changes detected."];
}
