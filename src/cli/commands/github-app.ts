/**
 * `fleetmind github-app store` — push GitHub App credentials into AWS SSM
 * Parameter Store under the FleetMind per-agent path namespace.
 *
 * SSM paths written:
 *   /fleetmind/<fleet>/agents/<agent>/github-app/app-id            (String)
 *   /fleetmind/<fleet>/agents/<agent>/github-app/installation-id    (String)
 *   /fleetmind/<fleet>/agents/<agent>/github-app/pem                (SecureString)
 *
 * This is the TS/CLI equivalent of infra/scripts/store-bot-github-app.sh and
 * is the preferred way to store credentials for operators with a Node runtime.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { Command } from "commander";
import chalk from "chalk";
import { SSMClient, PutParameterCommand, ParameterType } from "@aws-sdk/client-ssm";
import { log } from "../../utils/log.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal interface for the SSM send method — allows injection in tests. */
export interface SsmSendable {
  send(command: PutParameterCommand): Promise<unknown>;
}

export interface GithubAppStoreOptions {
  fleet: string;
  agent: string;
  appId: string;
  installationId: string;
  pemFile: string;
  region: string;
  dryRun: boolean;
  overwrite: boolean;
  /** Injectable SSM client for unit tests. When omitted a real SSMClient is created. */
  ssmClient?: SsmSendable;
}

export interface GithubAppStoreResult {
  namespace: string;
  region: string;
  params: Array<{
    name: string;
    type: ParameterType;
    valueHint: string;
    written: boolean; // false in dry-run
  }>;
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function storeGithubApp(
  options: GithubAppStoreOptions
): Promise<GithubAppStoreResult> {
  // ── Validate + read PEM ───────────────────────────────────────────────────
  const pemPath = (() => {
    try { return fs.realpathSync(options.pemFile); }
    catch { return options.pemFile; }
  })();

  if (!fs.existsSync(pemPath)) {
    throw new Error(`PEM file not found: ${options.pemFile}`);
  }

  const pemContents = fs.readFileSync(pemPath, "utf-8").trim();
  if (!pemContents) {
    throw new Error(`PEM file is empty: ${options.pemFile}`);
  }

  // Compute a short digest for log output instead of printing PEM contents
  const pemDigest = crypto
    .createHash("sha256")
    .update(pemContents)
    .digest("hex")
    .slice(0, 12);

  // ── Build SSM paths ───────────────────────────────────────────────────────
  const namespace = `/fleetmind/${options.fleet}/agents/${options.agent}/github-app`;

  const params: GithubAppStoreResult["params"] = [
    {
      name: `${namespace}/app-id`,
      type: ParameterType.STRING,
      valueHint: options.appId,
      written: false,
    },
    {
      name: `${namespace}/installation-id`,
      type: ParameterType.STRING,
      valueHint: options.installationId,
      written: false,
    },
    {
      name: `${namespace}/pem`,
      type: ParameterType.SECURE_STRING,
      valueHint: `<redacted sha256:${pemDigest}...>`,
      written: false,
    },
  ];

  const values: Record<string, string> = {
    [`${namespace}/app-id`]: options.appId,
    [`${namespace}/installation-id`]: options.installationId,
    [`${namespace}/pem`]: pemContents,
  };

  // ── Dry-run path ──────────────────────────────────────────────────────────
  if (options.dryRun) {
    console.log(chalk.dim("\n[dry-run] Would write the following SSM parameters:"));
    for (const p of params) {
      const hint = p.type === ParameterType.SECURE_STRING ? "<redacted>" : p.valueHint;
      console.log(chalk.dim(`  ${p.name}  (${p.type})  = ${hint}`));
    }
    console.log(chalk.dim(`  region: ${options.region}`));
    console.log(chalk.dim(`  overwrite: ${options.overwrite}\n`));
    return { namespace, region: options.region, params };
  }

  // ── Live write ────────────────────────────────────────────────────────────
  const client: SsmSendable =
    options.ssmClient ?? new SSMClient({ region: options.region });

  for (const p of params) {
    await client.send(
      new PutParameterCommand({
        Name: p.name,
        Value: values[p.name]!,
        Type: p.type,
        Overwrite: options.overwrite,
      })
    );
    p.written = true;
  }

  return { namespace, region: options.region, params };
}

// ── Output ────────────────────────────────────────────────────────────────────

export function printStoreResult(
  result: GithubAppStoreResult,
  dryRun: boolean
): void {
  const action = dryRun ? chalk.dim("(dry-run — not written)") : chalk.green("written");

  console.log();
  log.ok(
    `GitHub App credentials ${dryRun ? "would be stored" : "stored"} in SSM`
  );
  console.log(`  namespace : ${chalk.cyan(result.namespace)}`);
  console.log(`  region    : ${chalk.cyan(result.region)}`);
  console.log();

  for (const p of result.params) {
    const hint = p.type === ParameterType.SECURE_STRING ? "<redacted>" : p.valueHint;
    console.log(`  ${chalk.bold(p.name)}`);
    console.log(`    type  : ${p.type}`);
    console.log(`    value : ${hint}`);
    console.log(`    status: ${action}`);
  }
  console.log();
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerGithubApp(program: Command): void {
  const githubApp = program
    .command("github-app")
    .description("Manage GitHub App credentials for fleet agents");

  githubApp
    .command("store")
    .description(
      "Push GitHub App credentials (app-id, installation-id, pem) into AWS SSM Parameter Store"
    )
    .requiredOption("--fleet <name>", "Fleet name (used as SSM path namespace)")
    .requiredOption("--agent <id>", "Agent ID within the fleet")
    .requiredOption("--app-id <id>", "GitHub App ID")
    .requiredOption("--installation-id <id>", "GitHub App Installation ID")
    .requiredOption("--pem-file <path>", "Path to the .pem private key file")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--dry-run", "Print what would be written without calling SSM", false)
    .option(
      "--no-overwrite",
      "Fail if a parameter already exists (default: overwrite)"
    )
    .action(async (opts) => {
      try {
        const result = await storeGithubApp({
          fleet: opts.fleet as string,
          agent: opts.agent as string,
          appId: opts.appId as string,
          installationId: opts.installationId as string,
          pemFile: opts.pemFile as string,
          region: opts.region as string,
          dryRun: opts.dryRun as boolean,
          overwrite: opts.overwrite as boolean,
        });
        printStoreResult(result, opts.dryRun as boolean);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
      }
    });
}
