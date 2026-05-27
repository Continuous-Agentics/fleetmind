/**
 * `fleetmind secrets populate` — push per-agent Slack + model-provider
 * credentials from environment variables into AWS Secrets Manager.
 *
 * Secret naming follows the Terraform convention (one secret per provider, so
 * the runtime reader keeps consuming `/anthropic` unchanged and new providers
 * are parallel secrets):
 *   ${fleet_name}/agents/${agent_id}/slack
 *   ${fleet_name}/agents/${agent_id}/<provider>      e.g. /anthropic, /openai
 *   ${fleet_name}/agents/${agent_id}/hooks
 *
 * FleetMind is provider-neutral: the set of providers an agent needs is derived
 * from its `model` ("provider/model") plus any explicit `api_keys` entries.
 * Per-provider key resolution order (provider P):
 *   1. ${<AGENT_ID_UPPER>_<P_UPPER>_API_KEY}  (per-agent)
 *   2. agent.api_keys[P] placeholder/literal from fleet.yaml
 *   3. ${<P_UPPER>_API_KEY}                    (fleet-wide fallback)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import yaml from "js-yaml";
import chalk from "chalk";
import { SecretsManagerClient, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { log } from "../../utils/log.js";
import {
  providerApiKeyVar,
  agentProviderApiKeyVar,
  providersForAgent,
} from "../../core/model-provider.js";

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

/** A raw channel entry from fleet.yaml (v2 `agents.list[].channels`). */
interface RawChannel {
  provider?: string;
  bot_token?: string;
  app_token?: string;
  account_id?: string;
}

interface RawAgent {
  id?: string;
  name?: string;
  /** "provider/model" string; falls back to agents.defaults.model. */
  model?: string;
  channels?: RawChannel[];
  /** Per-provider API-key placeholders/literals. */
  api_keys?: Record<string, string>;
}

interface RawFleet {
  fleet?: { name?: string };
  delegation?: { aws_region?: string };
  agents?: { defaults?: { model?: string }; list?: RawAgent[] };
}

/** The Slack channel entry from a raw agent's v2 `channels` list, if any. */
function rawAgentSlack(agent: RawAgent): AgentSlack | undefined {
  const ch = agent.channels?.find((c) => c.provider === "slack");
  if (!ch) return undefined;
  return { bot_token: ch.bot_token, app_token: ch.app_token, account_id: ch.account_id };
}

/** The model providers a raw agent needs keys for (see providersForAgent). */
function agentProviders(agent: RawAgent, defaultsModel: string | undefined): string[] {
  return providersForAgent({ model: agent.model, apiKeys: agent.api_keys, defaultModel: defaultsModel });
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

export interface ApiKeyResolution {
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

/**
 * Resolve an agent's API key for a given model provider. See the file header
 * for the resolution order. `apiKeys` is the agent's optional api_keys map.
 */
export function resolveProviderKey(
  agentId: string,
  provider: string,
  apiKeys: Record<string, string> | undefined,
  env: Record<string, string>
): ApiKeyResolution {
  // 1. Per-agent env var
  const perAgentVar = agentProviderApiKeyVar(agentId, provider);
  if (env[perAgentVar]) {
    return { ok: true, value: env[perAgentVar], missing: [] };
  }

  // 2. Agent's api_keys[provider] field (may itself be a placeholder)
  const configured = apiKeys?.[provider];
  if (configured) {
    const resolved = resolveValue(configured, env);
    if (resolved) {
      return { ok: true, value: resolved, missing: [] };
    }
  }

  // 3. Fleet-wide fallback
  const fleetVar = providerApiKeyVar(provider);
  if (env[fleetVar]) {
    return { ok: true, value: env[fleetVar], missing: [] };
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
 * Resolve a provider API key, prompting if not available from env.
 * Re-prompts on empty input.
 */
async function resolveProviderKeyInteractive(
  agentId: string,
  agentName: string,
  provider: string,
  apiKeys: Record<string, string> | undefined,
  env: Record<string, string>,
  promptFn: (prompt: string) => Promise<string>
): Promise<ApiKeyResolution> {
  const res = resolveProviderKey(agentId, provider, apiKeys, env);
  if (res.ok) return res;

  let value = "";
  while (!value) {
    value = await promptFn(`${agentName} / ${providerApiKeyVar(provider)}: `);
  }
  return { ok: true, value, missing: [] };
}

// ── Core populate logic ───────────────────────────────────────────────────────

export interface PopulateResult {
  agentId: string;
  /** "slack", "hooks", or a model provider name (e.g. "anthropic", "openai"). */
  secretType: string;
  secretName: string;
  ok: boolean;
  pushed?: boolean;
  missing?: string[];
  keyCount?: number;
}

/** Push one secret (or record a dry-run) and append the result. Centralizes the
 *  dry-run / PutSecretValue / result-record pattern shared by every secret. */
async function emitSecret(
  results: PopulateResult[],
  client: SecretsManagerClient | null,
  dryRun: boolean,
  base: { agentId: string; secretType: string; secretName: string },
  data: Record<string, string>
): Promise<void> {
  const keyCount = Object.keys(data).length;
  if (dryRun) {
    results.push({ ...base, ok: true, pushed: false, keyCount });
    return;
  }
  await client!.send(
    new PutSecretValueCommand({ SecretId: base.secretName, SecretString: JSON.stringify(data) })
  );
  results.push({ ...base, ok: true, pushed: true, keyCount });
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

  // Fleet-wide default model — supplies the provider for agents that don't set
  // their own `model`. (Raw YAML, so no schema default is applied here.)
  const defaultsModel = rawFleet?.agents?.defaults?.model;

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
      secretType: string;
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
      const slackRes = await resolveSlackInteractive(agentId, agentName, rawAgentSlack(agent), env, promptFn);
      ready.push({
        agentId,
        secretType: "slack",
        secretName: slackSecretName,
        data: slackRes.values as Record<string, string>,
        keyCount: Object.keys(slackRes.values).length,
      });

      // Model-provider keys — one secret per provider this agent uses.
      for (const provider of agentProviders(agent, defaultsModel)) {
        const res = await resolveProviderKeyInteractive(agentId, agentName, provider, agent.api_keys, env, promptFn);
        ready.push({
          agentId,
          secretType: provider,
          secretName: `${fleetName}/agents/${agentId}/${provider}`,
          data: { [providerApiKeyVar(provider)]: res.value! },
          keyCount: 1,
        });
      }

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
        await interactiveClient!.send(new PutSecretValueCommand({
          SecretId: r.secretName,
          SecretString: JSON.stringify(r.data),
        }));
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
    const slackRes = resolveSlack(agentId, rawAgentSlack(agent), env);
    if (slackRes.ok) {
      await emitSecret(results, client, options.dryRun,
        { agentId, secretType: "slack", secretName: slackSecretName },
        slackRes.values);
    } else {
      results.push({ agentId, secretType: "slack", secretName: slackSecretName, ok: false, missing: slackRes.missing });
    }

    // ── Model-provider keys — one secret per provider this agent uses ──────────
    for (const provider of agentProviders(agent, defaultsModel)) {
      const secretName = `${fleetName}/agents/${agentId}/${provider}`;
      const res = resolveProviderKey(agentId, provider, agent.api_keys, env);
      if (res.ok) {
        await emitSecret(results, client, options.dryRun,
          { agentId, secretType: provider, secretName },
          { [providerApiKeyVar(provider)]: res.value! });
      } else {
        results.push({ agentId, secretType: provider, secretName, ok: false, missing: res.missing });
      }
    }

    // ── Hooks token — always auto-generated; never read from env ────────────────
    await emitSecret(results, client, options.dryRun,
      { agentId, secretType: "hooks", secretName: `${fleetName}/agents/${agentId}/hooks` },
      { HOOKS_TOKEN: generateHooksToken() });
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
