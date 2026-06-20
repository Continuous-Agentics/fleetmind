import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SecretsManagerClient, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";
import { saveSecret, listSecretKeys, exportSecrets } from "../../utils/secrets.js";
import { log } from "../../utils/log.js";
import { populateSecrets, printResults, loadEnvFile, promptHidden, promptConfirm } from "./populate.js";
import { providersForAgent } from "../../core/model-provider.js";
import {
  slackSecretName,
  hooksSecretName,
  gatewaySecretName,
  providerSecretName,
} from "../../core/secret-names.js";

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
  check      Verify which expected AWS Secrets Manager secrets exist (read-only)

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

  secrets
    .command("check")
    .description("Verify which expected per-agent Secrets Manager secrets exist (read-only, no mutation)")
    .option("-f, --fleet <path>", "Path to fleet.yaml", "fleet.yaml")
    .option("--agent <id>", "Check only this agent (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--region <region>", "AWS region (default: delegation.aws_region from fleet.yaml or AWS env)")
    .addHelpText("after", `
Verifies naming parity between fleet.yaml + the per-provider Secrets Manager
layout that 'fleetmind secrets populate' targets and the per-agent module of
terraform-aws-fleetmind (>= v0.5.0) actually provisions. Does not read or
write secret values — only DescribeSecret per expected name.

Examples:
  $ fleetmind secrets check
  $ fleetmind secrets check --agent ranger
`)
    .action(async (opts) => {
      try {
        const fleetPath = path.resolve(opts.fleet);
        if (!fs.existsSync(fleetPath)) {
          throw new Error(`Fleet file not found: ${fleetPath}`);
        }
        const raw = yaml.load(fs.readFileSync(fleetPath, "utf-8")) as {
          fleet?: { name?: string };
          delegation?: { aws_region?: string };
          agents?: {
            defaults?: { model?: string };
            list?: Array<{ id?: string; model?: string; providers?: string[]; api_keys?: Record<string, string> }>;
          };
        };
        const fleetName = raw?.fleet?.name;
        if (!fleetName) throw new Error("fleet.name is required in fleet.yaml");
        const region = opts.region
          ?? raw?.delegation?.aws_region
          ?? process.env.AWS_REGION
          ?? process.env.AWS_DEFAULT_REGION;
        if (!region) throw new Error("AWS region not specified (use --region or set AWS_REGION).");

        const filter: Set<string> | null = (opts.agent && opts.agent.length > 0)
          ? new Set(opts.agent as string[])
          : null;
        const agents = (raw?.agents?.list ?? []).filter(a => a.id && (!filter || filter.has(a.id)));
        if (agents.length === 0) {
          log.warn("No matching agents in fleet.yaml.");
          return;
        }

        const client = new SecretsManagerClient({ region });
        let okCount = 0;
        let missCount = 0;

        for (const agent of agents) {
          const agentId = agent.id!;
          const providers = providersForAgent({
            agentId,
            providers: agent.providers,
            model: agent.model,
            apiKeys: agent.api_keys,
            defaultModel: raw.agents?.defaults?.model,
          });
          const expected: string[] = [
            slackSecretName(fleetName, agentId),
            hooksSecretName(fleetName, agentId),
            gatewaySecretName(fleetName, agentId),
            ...providers.map((p) => providerSecretName(fleetName, agentId, p)),
          ];
          for (const name of expected) {
            try {
              await client.send(new DescribeSecretCommand({ SecretId: name }));
              okCount++;
              console.log(`  ${chalk.green("✓")} ${name}`);
            } catch (err: unknown) {
              missCount++;
              const e = err as { name?: string; message?: string };
              const reason = e?.name === "ResourceNotFoundException" ? "missing" : (e?.name ?? "error");
              console.log(`  ${chalk.red("✗")} ${name}  ${chalk.dim(`(${reason})`)}`);
            }
          }
        }

        console.log();
        console.log(`Present: ${okCount}   Missing/Errored: ${missCount}   Region: ${region}`);
        if (missCount > 0) {
          console.log();
          console.log(chalk.yellow("Hint: if /providers/<provider> secrets are missing but /model is present,"));
          console.log(chalk.yellow("      your terraform-aws-fleetmind module is older than v0.5.0 — bump the"));
          console.log(chalk.yellow("      ref= in main.tf, terraform apply, then re-run `fleetmind secrets populate`."));
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
      }
    });
}
