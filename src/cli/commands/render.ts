import { Command } from "commander";
import path from "node:path";
import { loadFleet } from "../../config/loader.js";
import { writeOutputs } from "../../runtime/renderer.js";
import { computeFleetSkillGaps } from "../../runtime/skills-manifest.js";
import { skillsManifestPath } from "../../runtime/bot-types.js";
import { addSkillsToFleetYaml } from "./skill.js";
import { log } from "../../utils/log.js";

function describeSkill(s: { name: string; source: string; author?: string }): string {
  return s.source === "clawhub" && s.author ? `${s.author}/${s.name} (clawhub)` : `${s.name} (${s.source})`;
}

export function registerRender(program: Command): void {
  program
    .command("render [fleet]")
    .option("-f, --fleet <path>", "fleet.yaml path (overrides positional arg and FLEET_YAML env var)")
    .description("Render openclaw.json and terraform vars without deploying")
    .option("-o, --out <dir>", "Output base directory", ".")
    .option("--check", "Validate fleet.yaml against bot-type manifests without mutating or rendering. Exits non-zero on missing required skills.")
    .option("--dry-run", "Alias for --check.")
    .addHelpText("after", `
Examples:
  # Render openclaw.json + terraform vars for the default fleet.yaml.
  # Before rendering, auto-injects any required skills missing from each
  # agent (per its role's openclaw/<bot-type>/skills.yaml manifest).
  $ fleetmind render

  # Render a specific fleet file
  $ fleetmind render acme-fleet.yaml

  # CI-friendly: validate without mutating fleet.yaml or writing outputs
  $ fleetmind render --check       # or --dry-run

  # Write rendered outputs to a custom directory
  $ fleetmind render --out ./build
`)
    .action((fleetArg: string | undefined, opts: { fleet?: string; out: string; check?: boolean; dryRun?: boolean }) => {
      const fleetFile = opts.fleet ?? fleetArg ?? "fleet.yaml";
      const checkOnly = Boolean(opts.check || opts.dryRun);
      try {
        const fleet = loadFleet(fleetFile);
        const gaps = computeFleetSkillGaps(fleet.agents.list);
        const gapsWithMissing = gaps.filter((g) => g.missing.length > 0);

        if (checkOnly) {
          if (gapsWithMissing.length === 0) {
            log.ok(`fleetmind render --check: all agents have required skills for fleet ${fleet.fleet.name}.`);
            return;
          }
          log.error(`fleetmind render --check: ${gapsWithMissing.length} agent${gapsWithMissing.length === 1 ? "" : "s"} missing required skills:`);
          for (const gap of gapsWithMissing) {
            log.error(`  ${gap.agentId} (role: ${gap.role}):`);
            for (const s of gap.missing) {
              log.error(`      - ${describeSkill(s)}`);
            }
          }
          log.error("");
          log.error("Run 'fleetmind render' (without --check) to auto-inject these.");
          process.exit(1);
        }

        // Default mode: auto-inject any missing required skills before rendering.
        if (gapsWithMissing.length > 0) {
          const fleetAbsPath = path.resolve(fleetFile);
          const additions = gapsWithMissing.flatMap((gap) =>
            gap.missing.map((skill) => ({ agentId: gap.agentId, skill })),
          );

          log.bold(`Auto-injecting required skills per bot-type manifests...`);
          const result = addSkillsToFleetYaml(fleetAbsPath, additions);

          // Re-correlate added entries with their source manifest for the log
          // trail (so each line points at where the requirement came from).
          for (const addition of result.added) {
            const gap = gapsWithMissing.find((g) => g.agentId === addition.agentId);
            const skill = gap?.missing.find((s) => s.name === addition.skillName);
            if (!skill) continue;
            const manifestPath = skillsManifestPath(gap!.role) ?? "<unknown>";
            log.ok(`  + ${addition.agentId}: ${describeSkill(skill)}  [from ${manifestPath}]`);
          }
          log.info("");
        }

        // Reload fleet from the now-mutated file before rendering, so the
        // rendered openclaw.json reflects the newly-added skills.
        const fleetForRender = gapsWithMissing.length > 0 ? loadFleet(fleetFile) : fleet;

        const written = writeOutputs(fleetForRender, opts.out);

        log.bold(`Rendered outputs for fleet ${fleetForRender.fleet.name}:`);
        for (const [name, p] of Object.entries(written)) {
          log.ok(`${name}: ${p}`);
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
