/**
 * `fleetmind secrets populate` — push per-agent Slack + Anthropic credentials
 * from environment variables into AWS Secrets Manager.
 *
 * Secret naming follows the Terraform convention:
 *   ${fleet_name}/agents/${agent_id}/slack
 *   ${fleet_name}/agents/${agent_id}/anthropic
 *
 * Anthropic key resolution order:
 *   1. ${<AGENT_ID_UPPER>_ANTHROPIC_API_KEY}  (per-agent)
 *   2. ${ANTHROPIC_API_KEY}                    (fleet-wide fallback)
 *   3. agent.anthropic.api_key placeholder from fleet.yaml
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import yaml from "js-yaml";
import chalk from "chalk";
import { SecretsManagerClient, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { log } from "../../utils/log.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PopulateOptions {
  fleet: string;
  dryRun: boolean;
  from?: string;
  agent?: string[];
  region?: string;
  interactive?: boolean;
  /** Injectable prompt function for hidden input — used in tests to avoid raw-mode TTY. */
  promptFn?: (prompt: string) => Promise<string>;
  /** Injectable confirm function for y/N prompt — used in tests. */
  confirmFn?: (prompt: string) => Promise<boolean>;
}

interface AgentSlack {
  bot_token?: string;
  app_token?: string;
  account_id?: string;
}

interface AgentAnthropicConfig {
  api_key?: string;
}

interface RawAgent {
  id?: string;
  name?: string;
  slack?: AgentSlack;
  anthropic?: AgentAnthropicConfig;
}

interface RawFleet {
  fleet?: { name?: string };
  delegation?: { aws_region?: string };
  agents?: { list?: RawAgent[] };
}

// ── Env-file loader ───────────────────────────────────────────────────────────

/**
 * Parse a .env-style file and return key→value pairs.
 * Does NOT override existing process.env entries (additive only).
 */
export function loadEnvFile(filePath: string): Record<string, string> {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Env file not found: ${abs}`);
  }
  const lines = fs.readFileSync(abs, "utf-8").split("\n");
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

// ── Placeholder resolver ──────────────────────────────────────────────────────

/** Extract the env var name from a ${VAR} placeholder string. Returns null if not a placeholder. */
export function extractPlaceholder(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^\$\{([^}]+)\}$/);
  return m ? m[1]! : null;
}

/** Resolve a placeholder or literal value from env. Returns the resolved string or null. */
export function resolveValue(
  value: string | undefined,
  env: Record<string, string>
): string | null {
  if (!value) return null;
  const varName = extractPlaceholder(value);
  if (varName) {
    return env[varName] ?? null;
  }
  // Already a literal (not a placeholder)
  return value;
}

// ── Interactive prompts ──────────────────────────────────────────────────────

/**
 * Prompt for a hidden (secret) value using raw-mode stdin.
 * No echo. Backspace supported. Ctrl-C exits with code 130.
 * Injectable via PopulateOptions.promptFn for unit tests.
 */
export async function promptHidden(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let value = "";
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: Buffer | string) => {
      const ch = chunk.toString();
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          process.stdout.write("\n");
          rl.close();
          resolve(value);
          return;
        } else if (c === "\u0003") {
          // Ctrl-C
          process.stdout.write("\n");
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          rl.close();
          process.exit(130);
        } else if (c === "\u007F" || c === "\b") {
          value = value.slice(0, -1);
        } else {
          value += c;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

/**
 * Prompt for a y/N confirmation using plain readline (no hidden input needed).
 */
export async function promptConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

// ── Redaction ─────────────────────────────────────────────────────────────────

/** Redact a token for dry-run display: show first 8 + last 4 chars */
export function redact(value: string): string {
  if (value.length <= 12) return "***";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

// ── Resolution result ─────────────────────────────────────────────────────────

export interface SlackResolution {
  ok: boolean;
  values: { SLACK_BOT_TOKEN?: string; SLACK_APP_TOKEN?: string };
  missing: string[];
}

export interface AnthropicResolution {
  ok: boolean;
  value?: string;
  missing: string[];
}

export function resolveSlack(
  agentId: string,
  slack: AgentSlack | undefined,
  env: Record<string, string>
): SlackResolution {
  const missing: string[] = [];
  const values: SlackResolution["values"] = {};

  const fields: Array<{ field: keyof AgentSlack; outKey: keyof SlackResolution["values"] }> = [
    { field: "bot_token", outKey: "SLACK_BOT_TOKEN" },
    { field: "app_token", outKey: "SLACK_APP_TOKEN" },
  ];

  for (const { field, outKey } of fields) {
    const raw = slack?.[field];
    const varName = extractPlaceholder(raw);
    if (varName) {
      const resolved = env[varName];
      if (resolved) {
        values[outKey] = resolved;
      } else {
        missing.push(varName);
      }
    } else if (raw) {
      // Literal value — use as-is
      values[outKey] = raw;
    } else {
      // Missing field entirely
      const fallback = `${agentId.toUpperCase()}_${outKey}`;
      missing.push(fallback);
    }
  }

  return { ok: missing.length === 0, values, missing };
}

/** Generate a random 32-byte hooks token. Always auto-generated; never read from env. */
export function generateHooksToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function resolveAnthropic(
  agentId: string,
  anthropicConfig: AgentAnthropicConfig | undefined,
  env: Record<string, string>
): AnthropicResolution {
  // 1. Per-agent env var
  const perAgentVar = `${agentId.toUpperCase()}_ANTHROPIC_API_KEY`;
  if (env[perAgentVar]) {
    return { ok: true, value: env[perAgentVar], missing: [] };
  }

  // 2. Agent's anthropic.api_key field (may itself be a placeholder)
  if (anthropicConfig?.api_key) {
    const resolved = resolveValue(anthropicConfig.api_key, env);
    if (resolved) {
      return { ok: true, value: resolved, missing: [] };
    }
  }

  // 3. Fleet-wide fallback
  if (env["ANTHROPIC_API_KEY"]) {
    return { ok: true, value: env["ANTHROPIC_API_KEY"], missing: [] };
  }

  return {
    ok: false,
    missing: [perAgentVar],
  };
}

// ── Interactive resolution helpers ──────────────────────────────────────────

/**
 * Resolve Slack credentials field-by-field, prompting for any missing values.
 * Uses env-supplied value silently; only calls promptFn for gaps.
 * Re-prompts on empty input.
 */
async function resolveSlackInteractive(
  agentId: string,
  agentName: string,
  slack: AgentSlack | undefined,
  env: Record<string, string>,
  promptFn: (prompt: string) => Promise<string>
): Promise<SlackResolution> {
  const fields: Array<{
    field: keyof AgentSlack;
    outKey: keyof SlackResolution["values"];
  }> = [
    { field: "bot_token", outKey: "SLACK_BOT_TOKEN" },
    { field: "app_token", outKey: "SLACK_APP_TOKEN" },
  ];

  const values: SlackResolution["values"] = {};

  for (const { field, outKey } of fields) {
    const raw = slack?.[field];
    const varName = extractPlaceholder(raw);

    let resolved: string | null = null;
    if (varName) {
      resolved = env[varName] ?? null;
    } else if (raw) {
      resolved = raw;
    }

    if (resolved) {
      values[outKey] = resolved;
    } else {
      // Prompt until non-empty
      let value = "";
      while (!value) {
        value = await promptFn(`${agentName} / ${outKey}: `);
      }
      values[outKey] = value;
    }
  }

  return { ok: true, values, missing: [] };
}

/**
 * Resolve the Anthropic API key, prompting if not available from env.
 * Re-prompts on empty input.
 */
async function resolveAnthropicInteractive(
  agentId: string,
  agentName: string,
  anthropicConfig: AgentAnthropicConfig | undefined,
  env: Record<string, string>,
  promptFn: (prompt: string) => Promise<string>
): Promise<AnthropicResolution> {
  const res = resolveAnthropic(agentId, anthropicConfig, env);
  if (res.ok) return res;

  let value = "";
  while (!value) {
    value = await promptFn(`${agentName} / ANTHROPIC_API_KEY: `);
  }
  return { ok: true, value, missing: [] };
}

// ── Core populate logic ───────────────────────────────────────────────────────

export interface PopulateResult {
  agentId: string;
  secretType: "slack" | "anthropic" | "hooks";
  secretName: string;
  ok: boolean;
  pushed?: boolean;
  missing?: string[];
  keyCount?: number;
}

/** Look up the current AWS account id via STS, in the same region as the
 *  Secrets Manager client. Returns null with a reason string if it fails. */
async function describeCallerIdentity(
  region: string
): Promise<{ accountId: string | null; reason?: string }> {
  try {
    const sts = new STSClient({ region });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    return { accountId: id.Account ?? null };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { accountId: null, reason: `${e?.name ?? "Error"}: ${e?.message ?? String(err)}` };
  }
}

/** Re-throw AWS Secrets Manager errors with the secret name, account, and
 *  region attached so users see exactly which secret is missing in which AWS
 *  identity instead of the bare "can't find the specified secret" message. */
async function annotateSecretError(
  err: unknown,
  secretName: string,
  client: SecretsManagerClient
): Promise<Error> {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? "Error";
  const msg = e?.message ?? String(err);
  if (name === "ResourceNotFoundException") {
    const region =
      (await (client.config.region as () => Promise<string>)?.()) ?? "<unknown>";
    const caller = await describeCallerIdentity(region);
    const acct = caller.accountId
      ? `account ${caller.accountId}`
      : `account <unable to determine — STS GetCallerIdentity failed: ${caller.reason}>`;
    const wrapped = new Error(
      `Secret "${secretName}" was not found in AWS Secrets Manager for ${acct} in region ${region} ` +
      `(the AWS identity you're currently logged in as). ` +
      `Create it first (typically via \`terraform apply\` in your fleetmind-template repo), ` +
      `or re-check your AWS profile/region, then re-run \`fleetmind secrets populate\`. ` +
      `(AWS: ${msg})`
    );
    (wrapped as NodeJS.ErrnoException).name = name;
    return wrapped;
  }
  return new Error(`Failed to write secret "${secretName}": ${name}: ${msg}`);
}

export async function populateSecrets(options: PopulateOptions): Promise<PopulateResult[]> {
  // Load env file first (additive — don't override existing env)
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (options.from) {
    const fileEnv = loadEnvFile(options.from);
    for (const [k, v] of Object.entries(fileEnv)) {
      if (!env[k]) env[k] = v;
    }
  }

  // Load raw fleet.yaml (no env expansion — we need the placeholder names)
  const fleetPath = path.resolve(options.fleet);
  if (!fs.existsSync(fleetPath)) {
    throw new Error(`Fleet file not found: ${fleetPath}`);
  }
  const rawFleet = yaml.load(fs.readFileSync(fleetPath, "utf-8")) as RawFleet;

  const fleetName = rawFleet?.fleet?.name;
  if (!fleetName) throw new Error("fleet.name is required in fleet.yaml");

  const agents = rawFleet?.agents?.list ?? [];
  if (agents.length === 0) throw new Error("No agents found in fleet.yaml");

  // Filter by --agent flags if provided
  const targetIds = options.agent && options.agent.length > 0
    ? new Set(options.agent)
    : null;

  const filteredAgents = agents.filter(
    (a) => a.id && (!targetIds || targetIds.has(a.id))
  );

  // Determine AWS region
  const region =
    options.region ??
    rawFleet?.delegation?.aws_region ??
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"] ??
    "us-east-1";

  // ── Interactive mode ────────────────────────────────────────────────────────
  if (options.interactive) {
    const promptFn = options.promptFn ?? promptHidden;
    const confirmFn = options.confirmFn ?? promptConfirm;

    // Phase 1: resolve all secrets, prompting for any missing credentials
    interface ReadySecret {
      agentId: string;
      secretType: "slack" | "anthropic" | "hooks";
      secretName: string;
      data: Record<string, string>;
      keyCount: number;
    }
    const ready: ReadySecret[] = [];

    for (const agent of filteredAgents) {
      const agentId = agent.id!;
      const agentName = agent.name ?? agentId;

      // Slack
      const slackSecretName = `${fleetName}/agents/${agentId}/slack`;
      const slackRes = await resolveSlackInteractive(agentId, agentName, agent.slack, env, promptFn);
      ready.push({
        agentId,
        secretType: "slack",
        secretName: slackSecretName,
        data: slackRes.values as Record<string, string>,
        keyCount: Object.keys(slackRes.values).length,
      });

      // Anthropic
      const anthropicSecretName = `${fleetName}/agents/${agentId}/anthropic`;
      const anthropicRes = await resolveAnthropicInteractive(agentId, agentName, agent.anthropic, env, promptFn);
      ready.push({
        agentId,
        secretType: "anthropic",
        secretName: anthropicSecretName,
        data: { ANTHROPIC_API_KEY: anthropicRes.value! },
        keyCount: 1,
      });

      // Hooks token — always auto-generated; never read from env
      ready.push({
        agentId,
        secretType: "hooks",
        secretName: `${fleetName}/agents/${agentId}/hooks`,
        data: { HOOKS_TOKEN: generateHooksToken() },
        keyCount: 1,
      });
    }

    // Phase 2: show confirmation summary
    console.log(`\nAbout to push ${ready.length} secrets:`);
    for (const r of ready) {
      console.log(`  ✓ ${r.agentId}/${r.secretType} (${r.keyCount} key${r.keyCount !== 1 ? "s" : ""})`);
    }
    console.log();

    // Phase 3: y/N confirmation (skipped for --dry-run)
    if (!options.dryRun) {
      const confirmed = await confirmFn("Push to AWS? [y/N]: ");
      if (!confirmed) {
        console.log("Aborted.");
        return [];
      }
    }

    // Phase 4: push (or dry-run skip)
    let interactiveClient: SecretsManagerClient | null = null;
    if (!options.dryRun) {
      interactiveClient = new SecretsManagerClient({ region });
    }

    const interactiveResults: PopulateResult[] = [];
    for (const r of ready) {
      if (options.dryRun) {
        interactiveResults.push({
          agentId: r.agentId,
          secretType: r.secretType,
          secretName: r.secretName,
          ok: true,
          pushed: false,
          keyCount: r.keyCount,
        });
      } else {
        try {
          await interactiveClient!.send(new PutSecretValueCommand({
            SecretId: r.secretName,
            SecretString: JSON.stringify(r.data),
          }));
        } catch (err) {
          throw await annotateSecretError(err, r.secretName, interactiveClient!);
        }
        interactiveResults.push({
          agentId: r.agentId,
          secretType: r.secretType,
          secretName: r.secretName,
          ok: true,
          pushed: true,
          keyCount: r.keyCount,
        });
      }
    }

    return interactiveResults;
  }

  // ── Non-interactive mode (existing logic) ────────────────────────────────────

  // Set up Secrets Manager client (not used in dry-run)
  let client: SecretsManagerClient | null = null;
  if (!options.dryRun) {
    client = new SecretsManagerClient({ region });
  }

  const results: PopulateResult[] = [];

  for (const agent of agents) {
    const agentId = agent.id;
    if (!agentId) continue;
    if (targetIds && !targetIds.has(agentId)) continue;

    // ── Slack ────────────────────────────────────────────────────────────────
    const slackSecretName = `${fleetName}/agents/${agentId}/slack`;
    const slackRes = resolveSlack(agentId, agent.slack, env);

    if (!slackRes.ok) {
      results.push({
        agentId,
        secretType: "slack",
        secretName: slackSecretName,
        ok: false,
        missing: slackRes.missing,
      });
    } else {
      if (options.dryRun) {
        results.push({
          agentId,
          secretType: "slack",
          secretName: slackSecretName,
          ok: true,
          pushed: false,
          keyCount: Object.keys(slackRes.values).length,
        });
      } else {
        try {
          await client!.send(new PutSecretValueCommand({
            SecretId: slackSecretName,
            SecretString: JSON.stringify(slackRes.values),
          }));
        } catch (err) {
          throw await annotateSecretError(err, slackSecretName, client!);
        }
        results.push({
          agentId,
          secretType: "slack",
          secretName: slackSecretName,
          ok: true,
          pushed: true,
          keyCount: Object.keys(slackRes.values).length,
        });
      }
    }

    // ── Anthropic ────────────────────────────────────────────────────────────
    const anthropicSecretName = `${fleetName}/agents/${agentId}/anthropic`;
    const anthropicRes = resolveAnthropic(agentId, agent.anthropic, env);

    if (!anthropicRes.ok) {
      results.push({
        agentId,
        secretType: "anthropic",
        secretName: anthropicSecretName,
        ok: false,
        missing: anthropicRes.missing,
      });
    } else {
      if (options.dryRun) {
        results.push({
          agentId,
          secretType: "anthropic",
          secretName: anthropicSecretName,
          ok: true,
          pushed: false,
          keyCount: 1,
        });
      } else {
        try {
          await client!.send(new PutSecretValueCommand({
            SecretId: anthropicSecretName,
            SecretString: JSON.stringify({ ANTHROPIC_API_KEY: anthropicRes.value }),
          }));
        } catch (err) {
          throw await annotateSecretError(err, anthropicSecretName, client!);
        }
        results.push({
          agentId,
          secretType: "anthropic",
          secretName: anthropicSecretName,
          ok: true,
          pushed: true,
          keyCount: 1,
        });
      }
    }

    // ── Hooks token — always auto-generated; never read from env ────────────────
    const hooksSecretName = `${fleetName}/agents/${agentId}/hooks`;
    const hooksToken = generateHooksToken();
    if (options.dryRun) {
      results.push({
        agentId,
        secretType: "hooks",
        secretName: hooksSecretName,
        ok: true,
        pushed: false,
        keyCount: 1,
      });
    } else {
      try {
        await client!.send(new PutSecretValueCommand({
          SecretId: hooksSecretName,
          SecretString: JSON.stringify({ HOOKS_TOKEN: hooksToken }),
        }));
      } catch (err) {
        throw await annotateSecretError(err, hooksSecretName, client!);
      }
      results.push({
        agentId,
        secretType: "hooks",
        secretName: hooksSecretName,
        ok: true,
        pushed: true,
        keyCount: 1,
      });
    }
  }

  return results;
}

// ── Output formatting ─────────────────────────────────────────────────────────

export function printResults(
  results: PopulateResult[],
  dryRun: boolean,
  env: Record<string, string>
): void {
  let hasErrors = false;

  for (const r of results) {
    const label = `${r.agentId}/${r.secretType}`;
    if (r.ok) {
      const action = dryRun ? chalk.dim("(dry-run)") : "pushed";
      log.ok(`${label} — ${action} (${r.keyCount} key${r.keyCount !== 1 ? "s" : ""})`);
    } else {
      hasErrors = true;
      log.error(`${label} — missing env var${r.missing!.length !== 1 ? "s" : ""}: ${r.missing!.join(", ")}`);
      const exports = r.missing!.map((v) => `export ${v}=...`).join(" ");
      console.error(chalk.dim(`   Set: ${exports}`));
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
}
