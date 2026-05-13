import path from "node:path";
import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { provisionFleet } from "../../runtime/provisioner.js";
import { writeOutputs } from "../../runtime/renderer.js";
import { log } from "../../utils/log.js";

export function registerDeploy(program: Command): void {
  program
    .command("deploy [fleet]")
    .description("Render per-agent workspaces + openclaw.json locally to ./rendered/ (does not push to EC2 — use `push fleet` for that)")
    .option("--dry-run", "Show what would happen without doing it")
    .option("--no-render", "Skip rendering openclaw.json")
    .action((fleetArg: string | undefined, opts) => {
      const fleetFile = fleetArg ?? "fleet.yaml";
      try {
        const localBase = process.cwd();
        const fleet = loadFleet(fleetFile);
        provisionFleet(fleet, opts.dryRun ?? false, localBase);

        if (opts.render !== false && !opts.dryRun) {
          const written = writeOutputs(fleet);
          for (const [name, p] of Object.entries(written)) {
            // Keys are "openclaw_json:<agent_id>" (one per agent) and "terraform_vars"
            log.ok(`Rendered ${name} → ${p}`);
          }
          // Show where workspace directories were written so operators know
          // exactly where to look (and what to SCP to EC2).
          const wsBase = path.join(localBase, "rendered", "workspaces");
          for (const agent of fleet.agents.list) {
            log.ok(`Rendered workspace:${agent.id} → ${path.join(wsBase, agent.id)}/`);
          }
        }

        if (!opts.dryRun) {
          log.dim("\nTip: run `openclaw gateway restart` to apply the new config.");
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
