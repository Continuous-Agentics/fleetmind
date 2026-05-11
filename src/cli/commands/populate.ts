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

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import chalk from "chalk";
import { SecretsManagerClient, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { log } from "../../utils/log.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PopulateOptions {
  fleet: string;
  dryRun: boolean;
  from?: string;
  agent?: string[];
  region?: string;
}

interface AgentSlack {
  bot_token?: string;
  app_token?: string;
  signing_secret?: string;
  account_id?: string;
}

interface AgentAnthropicConfig {
  api_key?: string;
}

interface RawAgent {
  id?: string;
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

// ── Redaction ─────────────────────────────────────────────────────────────────

/** Redact a token for dry-run display: show first 8 + last 4 chars */
export function redact(value: string): string {
  if (value.length <= 12) return "***";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

// ── Resolution result ─────────────────────────────────────────────────────────

export interface SlackResolution {
  ok: boolean;
  values: { SLACK_BOT_TOKEN?: string; SLACK_APP_TOKEN?: string; SLACK_SIGNING_SECRET?: string };
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
    { field: "signing_secret", outKey: "SLACK_SIGNING_SECRET" },
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

// ── Core populate logic ───────────────────────────────────────────────────────

export interface PopulateResult {
  agentId: string;
  secretType: "slack" | "anthropic";
  secretName: string;
  ok: boolean;
  pushed?: boolean;
  missing?: string[];
  keyCount?: number;
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

  // Determine AWS region
  const region =
    options.region ??
    rawFleet?.delegation?.aws_region ??
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"] ??
    "us-east-1";

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
        await client!.send(new PutSecretValueCommand({
          SecretId: slackSecretName,
          SecretString: JSON.stringify(slackRes.values),
        }));
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
        await client!.send(new PutSecretValueCommand({
          SecretId: anthropicSecretName,
          SecretString: JSON.stringify({ ANTHROPIC_API_KEY: anthropicRes.value }),
        }));
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
