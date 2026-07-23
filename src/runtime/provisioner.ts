/**
 * FleetMind provisioner — creates agent workspaces and installs skills.
 *
 * Skills are resolved via the three-tier resolver:
 *   clawhub → public ClaWHub/GitHub skill
 *   private → Continuous Agentics private registry (GitHub Packages)
 *   client  → client's own skills_repo (default)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Fleet, AgentConfig } from "../config/schema.js";
import { installSkill } from "./resolver.js";
import { slackChannel } from "../core/channels.js";
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
    const peerSlack = slackChannel(peer);
    const userId = peerSlack?.bot_user_id ?? "TODO (run fleetmind slack discover)";
    const channels = (peerSlack?.channels ?? []).join(", ") || "(none configured)";
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
    .replaceAll("{{ID}}", agent.id)
    .replaceAll("{{EMOJI}}", agent.emoji ?? "")
    .replaceAll("{{DESCRIPTION}}", agent.description ?? "")
    .replaceAll("{{SOUL_BODY}}", agent.persona?.soul ?? "");

  if (fleet !== undefined) {
    result = result.replaceAll("{{FLEET_ROSTER}}", buildFleetRoster(fleet, agent));
  }

  return result;
}

/**
 * Absolute path to the fleetmind package root (where `openclaw/` lives).
 * Resolved from this file's own location so it works regardless of what
 * directory the operator runs `fleetmind` from.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Shared workspace template dir (relative to the package root). Holds files
 * that are byte-identical across every bot type (HEARTBEAT.md, MEMORY.md,
 * TOOLS.md) so there is exactly one copy to edit instead of one per role.
 * Role-specific dirs (openclaw/<bot-type>/workspace/) still take priority —
 * this is only a fallback when the role dir doesn't ship the file itself.
 */
const SHARED_WORKSPACE_TEMPLATE_DIR = "openclaw/_shared/workspace";

function readRoleTemplate(role: string, filename: string): string | null {
  const dir = workspaceTemplatePath(role) ?? workspaceTemplatePath("worker")!;
  const filePath = path.resolve(PACKAGE_ROOT, dir, filename);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");

  const sharedPath = path.resolve(PACKAGE_ROOT, SHARED_WORKSPACE_TEMPLATE_DIR, filename);
  if (fs.existsSync(sharedPath)) return fs.readFileSync(sharedPath, "utf8");

  return null;
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
  // while preserving bot-added task sections. Content is identical across every
  // role, so it lives once in SHARED_WORKSPACE_TEMPLATE_DIR and is picked up via
  // readRoleTemplate's fallback rather than duplicated per bot-type dir.
  const heartbeatTemplate = readRoleTemplate(role, "HEARTBEAT.md");
  if (heartbeatTemplate !== null) {
    writeFile(path.join(workspace, "HEARTBEAT.md"), heartbeatTemplate, dryRun);
  }

  // MEMORY.md — shipped on every push so the section merge can update
  // AUTO-tagged operator sections (e.g. Active Tasks) while preserving
  // everything the bot has written in untagged sections. Same shared-file
  // treatment as HEARTBEAT.md above.
  const memoryTemplate = readRoleTemplate(role, "MEMORY.md");
  if (memoryTemplate !== null) {
    writeFile(path.join(workspace, "MEMORY.md"), memoryTemplate, dryRun);
  }

  // TOOLS.md — only create if missing. pull-self protects this file from
  // being overwritten on existing agents, so this seeds it once for new agents.
  // Sourced from SHARED_WORKSPACE_TEMPLATE_DIR for every role (pm-bot and
  // backend-worker-bot previously shipped no TOOLS.md template at all, even
  // though every role's AGENTS.md boot sequence instructs the agent to read
  // TOOLS.md — the shared fallback closes that drift for all four bot types).
  const toolsMdTemplate = readRoleTemplate(role, "TOOLS.md");
  const toolsMdPath = path.join(workspace, "TOOLS.md");
  if (toolsMdTemplate !== null && !fs.existsSync(toolsMdPath)) {
    writeFile(toolsMdPath, applyPlaceholders(toolsMdTemplate, agent, fleet), dryRun);
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

  }

  return changes.length > 0 ? changes : ["No changes detected."];
}
