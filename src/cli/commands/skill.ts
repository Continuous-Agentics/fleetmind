/**
 * fleetmind skill — manage skills in fleet.yaml without hand-editing YAML.
 *
 * Subcommands:
 *   add    Add a skill to one or more agents
 *   remove Remove a skill from one or more agents
 *   list   Show skills currently declared per agent
 *
 * All subcommands write back to fleet.yaml preserving formatting and comments,
 * then remind you to run `fleetmind push fleet --restart` to deploy.
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument, YAMLMap, YAMLSeq, isMap, isSeq, isScalar, Pair, Scalar } from "yaml";
import type { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { log } from "../../utils/log.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillRef {
  name: string;
  source?: string;
  author?: string;
  version?: string;
}

// ── YAML helpers ──────────────────────────────────────────────────────────────

function skillMatches(entry: unknown, name: string): boolean {
  if (typeof entry === "string") return entry === name;
  if (isScalar(entry)) return entry.value === name;
  if (isMap(entry)) {
    const nameNode = entry.get("name");
    return (isScalar(nameNode) ? nameNode.value : nameNode) === name;
  }
  return false;
}

function buildSkillNode(skill: SkillRef): string | YAMLMap {
  if (!skill.source && !skill.author && !skill.version) {
    return skill.name;
  }
  const map = new YAMLMap();
  map.add(new Pair(new Scalar("name"), new Scalar(skill.name)));
  if (skill.source) map.add(new Pair(new Scalar("source"), new Scalar(skill.source)));
  if (skill.author) map.add(new Pair(new Scalar("author"), new Scalar(skill.author)));
  if (skill.version) map.add(new Pair(new Scalar("version"), new Scalar(skill.version)));
  return map;
}

// ── Core operations ───────────────────────────────────────────────────────────

export function addSkillToFleetYaml(
  fleetPath: string,
  targetIds: string[],
  skill: SkillRef,
): { added: string[]; skipped: string[] } {
  const result = addSkillsToFleetYaml(
    fleetPath,
    targetIds.map((agentId) => ({ agentId, skill })),
  );
  return {
    added: result.added.map((a) => a.agentId),
    skipped: result.skipped.map((s) => s.agentId),
  };
}

/**
 * Batched: add multiple (agent, skill) pairs in one read+write of fleet.yaml.
 *
 * Each pair is applied left-to-right against the same Document instance, then
 * the doc is written back once. Drastically reduces I/O when injecting many
 * required skills across many agents (e.g. `fleetmind render` against a fresh
 * fleet.yaml).
 *
 * Returns the flat list of (agentId, skillName) actually added, and the list
 * of those skipped because the agent already had the skill.
 */
export interface SkillAdditionResult {
  added: Array<{ agentId: string; skillName: string }>;
  skipped: Array<{ agentId: string; skillName: string }>;
}

export function addSkillsToFleetYaml(
  fleetPath: string,
  additions: ReadonlyArray<{ agentId: string; skill: SkillRef }>,
): SkillAdditionResult {
  const raw = fs.readFileSync(fleetPath, "utf-8");
  const doc = parseDocument(raw);

  const agentsList = doc.getIn(["agents", "list"]);
  if (!isSeq(agentsList)) throw new Error("fleet.yaml: agents.list is not a sequence");

  // Build a map of agentId -> index for O(1) lookup.
  const idToIndex = new Map<string, number>();
  agentsList.items.forEach((item, i) => {
    if (!isMap(item)) return;
    const agentId = item.get("id") as string;
    if (agentId) idToIndex.set(agentId, i);
  });

  const added: SkillAdditionResult["added"] = [];
  const skipped: SkillAdditionResult["skipped"] = [];

  for (const { agentId, skill } of additions) {
    const i = idToIndex.get(agentId);
    if (i === undefined) continue; // unknown agent; silently ignore

    const item = agentsList.items[i];
    if (!isMap(item)) continue;

    let skillsSeq = item.get("skills") as YAMLSeq | undefined;
    if (!skillsSeq || !isSeq(skillsSeq)) {
      skillsSeq = new YAMLSeq();
      doc.setIn(["agents", "list", i, "skills"], skillsSeq);
      skillsSeq = doc.getIn(["agents", "list", i, "skills"]) as YAMLSeq;
    }

    const alreadyHas = skillsSeq.items.some((e) => skillMatches(e, skill.name));
    if (alreadyHas) {
      skipped.push({ agentId, skillName: skill.name });
      continue;
    }

    skillsSeq.add(buildSkillNode(skill));
    added.push({ agentId, skillName: skill.name });
  }

  fs.writeFileSync(fleetPath, doc.toString(), "utf-8");
  return { added, skipped };
}

export function removeSkillFromFleetYaml(
  fleetPath: string,
  targetIds: string[],
  skillName: string
): { removed: string[]; notFound: string[] } {
  const raw = fs.readFileSync(fleetPath, "utf-8");
  const doc = parseDocument(raw);

  const agentsList = doc.getIn(["agents", "list"]);
  if (!isSeq(agentsList)) throw new Error("fleet.yaml: agents.list is not a sequence");

  const removed: string[] = [];
  const notFound: string[] = [];

  agentsList.items.forEach((item, i) => {
    if (!isMap(item)) return;
    const agentId = item.get("id") as string;
    if (!targetIds.includes(agentId)) return;

    const skillsSeq = item.get("skills");
    if (!isSeq(skillsSeq)) {
      notFound.push(agentId);
      return;
    }

    const idx = skillsSeq.items.findIndex(e => skillMatches(e, skillName));
    if (idx === -1) {
      notFound.push(agentId);
      return;
    }

    skillsSeq.items.splice(idx, 1);
    doc.setIn(["agents", "list", i, "skills"], skillsSeq);
    removed.push(agentId);
  });

  fs.writeFileSync(fleetPath, doc.toString(), "utf-8");
  return { removed, notFound };
}

// ── Commander registration ─────────────────────────────────────────────────────

export function registerSkill(program: Command): void {
  const skill = program
    .command("skill")
    .description("Manage skills in fleet.yaml")
    .addHelpText('after', `
Run \`fleetmind push fleet --restart\` after adding or removing skills to deploy changes.
`);

  // ── skill add ──────────────────────────────────────────────────────────────
  skill
    .command("add <name>")
    .description("Add a skill to one or more agents in fleet.yaml")
    .option("-f, --fleet <path>", "fleet.yaml path", "./fleet.yaml")
    .option("-a, --agent <id>", "Add to this agent (repeatable)",
      (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--all", "Add to all agents", false)
    .option("--role <role>", "Add to all agents with this role (e.g. pm, worker)")
    .option("--source <source>", "Skill source: client | fleetmind | clawhub", "client")
    .option("--author <author>", "ClawHub author (required for source: clawhub)")
    .option("--version <version>", "Skill version to pin")
    .addHelpText('after', `
Examples:
  # Add a fleet-local skill to one agent
  $ fleetmind skill add my-workflow --agent ariadne

  # Add a bundled fleetmind skill to all agents
  $ fleetmind skill add bot-reception --all --source fleetmind

  # Add a ClawHub skill to all worker-role agents
  $ fleetmind skill add aws-alert-handler --role worker --source clawhub --author ggettert --version 0.1.1
`)
    .action((skillName: string, opts: {
      fleet: string;
      agent: string[];
      all: boolean;
      role?: string;
      source: string;
      author?: string;
      version?: string;
    }) => {
      const fleet = loadFleet(opts.fleet);
      const fleetPath = path.resolve(opts.fleet);

      // Resolve target agent IDs
      let targetIds: string[];
      if (opts.all) {
        targetIds = fleet.agents.list.map(a => a.id);
      } else if (opts.role) {
        targetIds = fleet.agents.list
          .filter(a => a.role === opts.role)
          .map(a => a.id);
        if (targetIds.length === 0) {
          log.error(`No agents with role '${opts.role}' found in fleet.yaml`);
          process.exit(1);
        }
      } else if (opts.agent.length > 0) {
        targetIds = opts.agent;
      } else {
        log.error("Specify --agent <id>, --all, or --role <role>");
        process.exit(1);
      }

      if (opts.source === "clawhub" && !opts.author) {
        log.error("--author is required for source: clawhub");
        process.exit(1);
      }

      const { added, skipped } = addSkillToFleetYaml(fleetPath, targetIds, {
        name: skillName,
        source: opts.source !== "client" ? opts.source : undefined,
        author: opts.author,
        version: opts.version,
      });

      for (const id of added) log.ok(`  ${id}: added skill '${skillName}'`);
      for (const id of skipped) log.dim(`  ${id}: '${skillName}' already present — skipped`);

      if (added.length > 0) {
        log.info("\nfleet.yaml updated. Deploy with:");
        log.info("  fleetmind push fleet --restart");
      }
    });

  // ── skill remove ───────────────────────────────────────────────────────────
  skill
    .command("remove <name>")
    .description("Remove a skill from one or more agents in fleet.yaml")
    .option("-f, --fleet <path>", "fleet.yaml path", "./fleet.yaml")
    .option("-a, --agent <id>", "Remove from this agent (repeatable)",
      (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--all", "Remove from all agents", false)
    .option("--role <role>", "Remove from all agents with this role")
    .addHelpText('after', `
Examples:
  $ fleetmind skill remove my-workflow --agent ariadne
  $ fleetmind skill remove aws-alert-handler --all
`)
    .action((skillName: string, opts: {
      fleet: string;
      agent: string[];
      all: boolean;
      role?: string;
    }) => {
      const fleet = loadFleet(opts.fleet);
      const fleetPath = path.resolve(opts.fleet);

      let targetIds: string[];
      if (opts.all) {
        targetIds = fleet.agents.list.map(a => a.id);
      } else if (opts.role) {
        targetIds = fleet.agents.list.filter(a => a.role === opts.role).map(a => a.id);
      } else if (opts.agent.length > 0) {
        targetIds = opts.agent;
      } else {
        log.error("Specify --agent <id>, --all, or --role <role>");
        process.exit(1);
      }

      const { removed, notFound } = removeSkillFromFleetYaml(fleetPath, targetIds, skillName);

      for (const id of removed) log.ok(`  ${id}: removed skill '${skillName}'`);
      for (const id of notFound) log.dim(`  ${id}: '${skillName}' not found — skipped`);

      if (removed.length > 0) {
        log.info("\nfleet.yaml updated. Deploy with:");
        log.info("  fleetmind push fleet --restart");
      }
    });

  // ── skill list ─────────────────────────────────────────────────────────────
  skill
    .command("list")
    .description("Show skills declared per agent in fleet.yaml")
    .option("-f, --fleet <path>", "fleet.yaml path", "./fleet.yaml")
    .option("-a, --agent <id>", "Show only this agent (repeatable)",
      (v: string, prev: string[]) => [...prev, v], [] as string[])
    .action((opts: { fleet: string; agent: string[] }) => {
      const fleet = loadFleet(opts.fleet);
      const targets = opts.agent.length > 0
        ? fleet.agents.list.filter(a => opts.agent.includes(a.id))
        : fleet.agents.list;

      console.log(`\nSkills for fleet \x1b[1m${fleet.fleet.name}\x1b[0m:\n`);
      for (const agent of targets) {
        const skills = agent.skills ?? [];
        console.log(`  \x1b[1m${agent.emoji} ${agent.name}\x1b[0m (${agent.role ?? "worker"})`);
        if (skills.length === 0) {
          console.log(`    \x1b[2m(no skills declared)\x1b[0m`);
        } else {
          for (const s of skills) {
            const name = typeof s === "string" ? s : s.name;
            const src = typeof s === "string" ? "client" : (s.source ?? "client");
            const ver = typeof s === "string" ? "" : (s.version ? `@${s.version}` : "");
            const auth = typeof s === "string" ? "" : (s.author ? ` (${s.author})` : "");
            console.log(`    • ${name}${ver}  \x1b[2m[${src}]${auth}\x1b[0m`);
          }
        }
        console.log();
      }
    });
}
