/**
 * fleetmind doctor — read-only validation of a fleet.yaml.
 *
 * v1 checks:
 *   - Per-agent role manifest: every agent in fleet.yaml is checked against
 *     the matching openclaw/<bot-type>/skills.yaml. Missing required skills
 *     surface as errors; missing manifests (forward-compat for new roles)
 *     are reported as informational.
 *
 * Future checks (separate PRs):
 *   - SSM connectivity per agent
 *   - Slack token validity (auth.test)
 *   - Module-ref pinning lint
 *   - Secrets rotation age
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more errors
 */

import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { computeFleetSkillGaps } from "../../runtime/skills-manifest.js";
import { log } from "../../utils/log.js";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Validate fleet.yaml against bot-type skill manifests")
    .option("-f, --fleet <path>", "fleet.yaml path", "./fleet.yaml")
    .addHelpText("after", `
Examples:
  # Validate the default fleet.yaml against bot-type manifests
  $ fleetmind doctor

  # Validate a specific fleet file
  $ fleetmind doctor --fleet acme-fleet.yaml

Exit non-zero when any agent is missing required skills declared in its
role's manifest (openclaw/<bot-type>/skills.yaml). Fix with either:
  - 'fleetmind render'        (auto-injects missing required skills)
  - 'fleetmind skill add'     (per-skill manual control)
`)
    .action((opts: { fleet: string }) => {
      try {
        const fleet = loadFleet(opts.fleet);
        const gaps = computeFleetSkillGaps(fleet.agents.list);

        let errors = 0;
        let warnings = 0;
        let ok = 0;

        log.bold(`fleetmind doctor — fleet: ${fleet.fleet.name}`);
        log.info("");

        for (const gap of gaps) {
          if (gap.manifest === null) {
            log.dim(`  ? ${gap.agentId} (role: ${gap.role}): no skills.yaml for this role, skipping`);
            warnings += 1;
            continue;
          }
          if (gap.missing.length === 0) {
            log.ok(`  ✓ ${gap.agentId} (role: ${gap.role}): all ${gap.manifest.required.length} required skill${gap.manifest.required.length === 1 ? "" : "s"} present`);
            ok += 1;
          } else {
            log.error(`  ✗ ${gap.agentId} (role: ${gap.role}): missing ${gap.missing.length} required skill${gap.missing.length === 1 ? "" : "s"}:`);
            for (const s of gap.missing) {
              const where =
                s.source === "clawhub" && s.author
                  ? `${s.author}/${s.name} (clawhub)`
                  : `${s.name} (${s.source})`;
              log.error(`      - ${where}`);
            }
            errors += 1;
          }

          // Surface source mismatches as warnings even when the skill is
          // present-by-name. Operators may have declared a bundled skill with
          // source=client (shorthand default), which works only if a
          // same-named skill exists in their skills_repo.
          if (gap.sourceMismatches.length > 0) {
            for (const m of gap.sourceMismatches) {
              log.warn(`    ⚠  ${gap.agentId}: '${m.skillName}' declared with source=${m.declaredSource}, manifest expects source=${m.manifestSource}. Did you mean the bundled version?`);
              warnings += 1;
            }
          }
        }

        log.info("");
        log.info(`Summary: ${ok} agent${ok === 1 ? "" : "s"} ok, ${errors} with missing skills, ${warnings} warning${warnings === 1 ? "" : "s"}.`);

        if (errors > 0) {
          log.info("");
          log.info("To fix: run 'fleetmind render' to auto-inject missing skills, or 'fleetmind skill add' for manual control.");
          process.exit(1);
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
