import { Command } from "commander";
import chalk from "chalk";
import { saveSecret, listSecretKeys, exportSecrets } from "../../utils/secrets.js";
import { log } from "../../utils/log.js";
import { populateSecrets, printResults, loadEnvFile, promptHidden, promptConfirm } from "./populate.js";

export function registerSecrets(program: Command): void {
  const secrets = program
    .command("secrets")
    .description("Manage fleet secrets")
    .addHelpText('after', `
Subcommands:
  set        Store a secret in the local secret store
  list       List stored secret keys
  export     Export secrets as shell export statements
  populate   Push agent credentials into AWS Secrets Manager

Run \`fleetmind secrets <subcommand> --help\` for examples.
`);

  secrets
    .command("set <key> <value>")
    .description("Store a secret in the local secret store")
    .addHelpText('after', `
Examples:
  # Store a Slack bot token
  $ fleetmind secrets set CONDUCTOR_BOT_TOKEN xoxb-...

  # Store an Anthropic API key
  $ fleetmind secrets set ANTHROPIC_API_KEY sk-ant-...
`)
    .action((key: string, value: string) => {
      saveSecret(key, value);
      log.ok(`Secret ${chalk.bold(key)} stored.`);
    });

  secrets
    .command("list")
    .description("List stored secret keys (values never shown)")
    .addHelpText('after', `
Examples:
  # Show which secrets are stored (values are never displayed)
  $ fleetmind secrets list
`)
    .action(() => {
      const keys = listSecretKeys();
      if (keys.length === 0) {
        log.dim("No secrets stored.");
        return;
      }
      log.bold("Stored secrets:");
      for (const k of keys) {
        console.log(`  ${chalk.cyan(k)} = ${chalk.dim("***")}`);
      }
    });

  secrets
    .command("export")
    .description("Export secrets as shell export statements")
    .addHelpText('after', `
Examples:
  # Print all stored secrets as export statements (source into shell)
  $ fleetmind secrets export

  # Source secrets into the current shell environment
  $ source <(fleetmind secrets export)
`)
    .action(() => {
      console.log(exportSecrets());
    });

  secrets
    .command("populate")
    .description("Push per-agent Slack + Anthropic credentials into AWS Secrets Manager")
    .option("-f, --fleet <path>", "Path to fleet.yaml", "fleet.yaml")
    .option("--dry-run", "Print what would be pushed without calling AWS", false)
    .option("--from <path>", "Load env vars from a .env-style file (does not override existing env)")
    .option("--agent <id>", "Populate only this agent (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--region <region>", "AWS region (default: delegation.aws_region from fleet.yaml or AWS env)")
    .option("-i, --interactive", "Prompt for each missing credential interactively (hidden input)", false)
    .addHelpText('after', `
Examples:
  # Interactive mode — prompts for each missing token (hidden input, no echo)
  $ fleetmind secrets populate --interactive

  # Load credentials from a .env file and push to AWS Secrets Manager
  $ fleetmind secrets populate --from .env.production

  # Dry-run: show what would be pushed without calling AWS
  $ fleetmind secrets populate --from .env.production --dry-run

  # Populate only one agent
  $ fleetmind secrets populate --agent pm-bot --from .env.production
`)
    .action(async (opts) => {
      try {
        const env: Record<string, string> = { ...process.env } as Record<string, string>;
        if (opts.from) {
          const fileEnv = loadEnvFile(opts.from);
          for (const [k, v] of Object.entries(fileEnv)) {
            if (!env[k]) env[k] = v;
          }
        }
        const results = await populateSecrets({
          fleet: opts.fleet,
          dryRun: opts.dryRun,
          from: opts.from,
          agent: opts.agent as string[],
          region: opts.region,
          interactive: opts.interactive as boolean,
        });
        printResults(results, opts.dryRun, env);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
      }
    });
}
