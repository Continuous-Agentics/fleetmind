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
import type { Fleet, AgentConfig } from "../config/schema.js";
import { installSkill } from "./resolver.js";
import { log } from "../utils/log.js";

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

export async function provisionAgent(
  fleet: Fleet,
  agent: AgentConfig,
  dryRun: boolean
): Promise<void> {
  const workspace = path.join(fleet.agents.defaults.workspace_base, `workspace-${agent.id}`);

  if (!dryRun) fs.mkdirSync(workspace, { recursive: true });

  writeFile(path.join(workspace, "SOUL.md"), soulMd(agent), dryRun);
  writeFile(path.join(workspace, "AGENTS.md"), agentsMd(agent), dryRun);
  writeFile(path.join(workspace, "IDENTITY.md"), identityMd(agent), dryRun);

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
}

export async function provisionFleet(fleet: Fleet, dryRun = false): Promise<void> {
  log.info(`\nFleetMind — provisioning fleet ${fleet.fleet.name}`);
  if (fleet.fleet.client) log.info(`  Client: ${fleet.fleet.client}`);
  log.info(`  Agents: ${fleet.agents.list.length}`);
  if (dryRun) log.warn("  Dry run — no changes will be made\n");

  for (const agent of fleet.agents.list) {
    log.step(`${agent.emoji} ${agent.name}...`);
    await provisionAgent(fleet, agent, dryRun);
    log.ok(`${agent.emoji} ${agent.name}`);
  }

  log.success("\nFleet provisioned.");
  log.info("  Next: run `fleetmind render` to generate openclaw.json");
}

export function diffFleet(fleet: Fleet): string[] {
  const changes: string[] = [];

  for (const agent of fleet.agents.list) {
    const workspace = path.join(
      fleet.agents.defaults.workspace_base,
      `workspace-${agent.id}`
    );

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
