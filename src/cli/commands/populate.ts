/**
 * `fleetmind secrets populate` — push per-agent Slack + model-provider
 * credentials from environment variables into AWS Secrets Manager.
 *
 * Secret naming follows the Terraform convention:
 *   ${fleet_name}/agents/${agent_id}/slack
 *   ${fleet_name}/agents/${agent_id}/providers/<provider>  — one secret per
 *      (agent, provider). JSON payload is { "<PROVIDER>_API_KEY": "<value>" }.
 *      The on-host fetch-agent-secrets iterates the agent's declared providers
 *      and merges every blob into the gateway env. Multi-provider agents get
 *      multiple secrets.
 *   ${fleet_name}/agents/${agent_id}/hooks
 *   ${fleet_name}/agents/${agent_id}/gateway
 *
 * Secret names come from src/core/secret-names.ts (shared with the Terraform
 * module — see terraform-aws-fleetmind/modules/agent/main.tf).
 *
 * FleetMind is provider-neutral, but providers are now EXPLICIT: each agent in
 * fleet.yaml must declare `providers: [anthropic, ...]`. There is no silent
 * inference from `model:` strings.
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
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { log } from "../../utils/log.js";
import {
  providerApiKeyVar,
  agentProviderApiKeyVar,
  providersForAgent,
} from "../../core/model-provider.js";
import {
  slackSecretName,
  hooksSecretName,
  gatewaySecretName,
  providerSecretName,
} from "../../core/secret-names.js";
import { slackChannel } from "../../core/channels.js";
import type { Fleet } from "../../core/model.js";

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
  /**
   * Force a fresh value for auto-generated tokens (hooks/gateway) even when the
   * secret already holds a valid one. Default false: re-running populate
   * preserves a live token instead of rotating it out from under running
   * services. Use this only when you deliberately want to roll a token.
   */
  rotateTokens?: boolean;
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
  /** REQUIRED — lowercase provider tokens this agent needs API keys for. */
  providers?: string[];
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

/** The model providers a raw agent needs keys for. Strict — throws if the
 *  agent does not declare an explicit providers list in fleet.yaml. */
function agentProviders(agent: RawAgent, defaultsModel: string | undefined): string[] {
  return providersForAgent({
    agentId: agent.id,
    providers: agent.providers,
    model: agent.model,
    apiKeys: agent.api_keys,
    defaultModel: defaultsModel,
  });
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

/** Generate a random 32-byte gateway auth token. Always auto-generated; never read from env. */
export function generateGatewayToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** A token value already present in Secrets Manager is considered "real" (worth
 *  preserving) when it is a 64-char hex string — i.e. a previously generated
 *  token, not the Terraform "PENDING_BOOTSTRAP" placeholder or empty. */
export function isRealToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Resolve an auto-generated token (hooks/gateway) idempotently. Reads the
 * existing secret and reuses its current token when it is a real value, so
 * re-running `populate` does NOT rotate a live token out from under running
 * services. Generates a fresh token only when the secret is absent, holds the
 * `PENDING_BOOTSTRAP` placeholder, or `rotate` is explicitly set.
 *
 * Mirrors the terraform-aws-fleetmind bootstrap STAGE 7b guard so all writers
 * (populate, bootstrap, TF placeholder) share one "don't clobber a real token"
 * contract. In dry-run (`client` is null) we skip the read and just generate.
 */
export async function resolveAutoToken(
  client: SecretsManagerClient | null,
  secretName: string,
  key: string,
  generate: () => string,
  rotate: boolean
): Promise<string> {
  if (rotate || !client) return generate();
  try {
    const resp = await client.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );
    if (resp.SecretString) {
      const parsed = JSON.parse(resp.SecretString) as Record<string, unknown>;
      if (isRealToken(parsed[key])) return parsed[key] as string;
    }
  } catch (err) {
    // ResourceNotFoundException (secret/version missing) → generate a new token.
    // Any other error (access denied, throttling) is non-fatal here: fall back
    // to generating so populate still produces a usable token; the subsequent
    // PutSecretValue will surface a real permissions error if one exists.
    const name = (err as { name?: string })?.name;
    if (name !== "ResourceNotFoundException") {
      // best-effort: leave a breadcrumb but don't abort populate
    }
  }
  return generate();
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

// ── Local host env materialization ───────────────────────────────────────────

export interface HostEnvResult {
  /** Resolved VAR=value pairs to write to the host's ~/.openclaw/.env. */
  vars: Record<string, string>;
  /** Env var names that could not be resolved (no value in env / local store). */
  missing: string[];
}

/**
 * Resolve every secret the single gateway on `targetId` needs, for a local
 * deploy (`fleetmind up`). Unlike `populateSecrets` (which pushes to AWS
 * Secrets Manager), this returns the values to write into `~/.openclaw/.env`,
 * which OpenClaw loads and substitutes into its config.
 *
 * For each agent on the host it collects:
 *  - Slack tokens — by the placeholder var name used in fleet.yaml (e.g.
 *    CONDUCTOR_BOT_TOKEN), since the rendered openclaw.json keeps `${VAR}` and
 *    OpenClaw resolves it from the env file.
 *  - Model-provider keys — `<PROVIDER>_API_KEY` (e.g. ANTHROPIC_API_KEY), which
 *    OpenClaw reads from the environment directly.
 *
 * The gateway env is process-global, so a var is resolved once (first agent
 * wins); model keys are therefore shared across co-located agents.
 *
 * Expects `fleet` loaded WITHOUT env expansion so Slack placeholders are intact
 * (see loadFleet `{ expandEnv: false }`).
 */
export function materializeHostEnv(
  fleet: Fleet,
  targetId: string,
  env: Record<string, string>
): HostEnvResult {
  const vars: Record<string, string> = {};
  const missing: string[] = [];
  const hostAgents = fleet.agents.list.filter((a) => fleet.targetForAgent(a).id === targetId);

  for (const agent of hostAgents) {
    // Slack tokens — keyed by the ${VAR} placeholder name in fleet.yaml.
    const slack = slackChannel(agent);
    for (const raw of [slack?.bot_token, slack?.app_token]) {
      const varName = extractPlaceholder(raw);
      if (!varName || vars[varName]) continue; // literal/absent, or already set
      const val = env[varName];
      if (val) vars[varName] = val;
      else missing.push(varName);
    }

    // Model-provider keys — <PROVIDER>_API_KEY, read by OpenClaw from env.
    const providers = providersForAgent({
      agentId: agent.id,
      providers: agent.providers,
      model: agent.model,
      apiKeys: agent.api_keys,
      defaultModel: fleet.agents.defaults.model,
    });
    for (const provider of providers) {
      const varName = providerApiKeyVar(provider);
      if (vars[varName]) continue;
      const res = resolveProviderKey(agent.id, provider, agent.api_keys, env);
      if (res.ok && res.value) vars[varName] = res.value;
      else missing.push(varName);
    }
  }

  return { vars, missing: [...new Set(missing)] };
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
  try {
    await client!.send(
      new PutSecretValueCommand({ SecretId: base.secretName, SecretString: JSON.stringify(data) })
    );
  } catch (err) {
    throw await annotateSecretError(err, base.secretName, client!);
  }
  results.push({ ...base, ok: true, pushed: true, keyCount });
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
    const providerHint = /\/providers\/([a-z0-9_-]+)$/.exec(secretName);
    const providerSuffix = providerHint
      ? ` Expected because fleet.yaml lists provider '${providerHint[1]}' for this agent. ` +
        `Confirm your terraform-aws-fleetmind module is at >= v0.5.0 (the per-provider ` +
        `secret release; older modules created a single '/model' secret instead) and re-apply.`
      : "";
    const wrapped = new Error(
      `Secret "${secretName}" was not found in AWS Secrets Manager for ${acct} in region ${region} ` +
      `(the AWS identity you're currently logged in as). ` +
      `Create it first (typically via \`terraform apply\` in your fleetmind-template repo), ` +
      `or re-check your AWS profile/region, then re-run \`fleetmind secrets populate\`.` +
      providerSuffix +
      ` (AWS: ${msg})`
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
      /** For auto-generated tokens: the payload key to resolve idempotently at
       *  push time (reuse a live token unless --rotate-tokens). */
      autoTokenKey?: string;
      /** Generator used when no real token exists yet (or on rotate). */
      generate?: () => string;
    }
    const ready: ReadySecret[] = [];

    for (const agent of filteredAgents) {
      const agentId = agent.id!;
      const agentName = agent.name ?? agentId;

      // Slack
      const slackName = slackSecretName(fleetName, agentId);
      const slackRes = await resolveSlackInteractive(agentId, agentName, rawAgentSlack(agent), env, promptFn);
      ready.push({
        agentId,
        secretType: "slack",
        secretName: slackName,
        data: slackRes.values as Record<string, string>,
        keyCount: Object.keys(slackRes.values).length,
      });

      // Model-provider keys — fan out, one secret per (agent, provider).
      for (const provider of agentProviders(agent, defaultsModel)) {
        const res = await resolveProviderKeyInteractive(agentId, agentName, provider, agent.api_keys, env, promptFn);
        const keyVar = providerApiKeyVar(provider);
        ready.push({
          agentId,
          secretType: `provider:${provider}`,
          secretName: providerSecretName(fleetName, agentId, provider),
          data: { [keyVar]: res.value! },
          keyCount: 1,
        });
      }

      // Hooks token — auto-generated, but preserved across re-runs unless
      // --rotate-tokens (resolved against AWS at push time below).
      ready.push({
        agentId,
        secretType: "hooks",
        secretName: hooksSecretName(fleetName, agentId),
        data: { HOOKS_TOKEN: generateHooksToken() },
        keyCount: 1,
        autoTokenKey: "HOOKS_TOKEN",
        generate: generateHooksToken,
      });

      // Gateway auth token — auto-generated, but preserved across re-runs unless
      // --rotate-tokens (resolved against AWS at push time below).
      ready.push({
        agentId,
        secretType: "gateway",
        secretName: gatewaySecretName(fleetName, agentId),
        data: { GATEWAY_TOKEN: generateGatewayToken() },
        keyCount: 1,
        autoTokenKey: "GATEWAY_TOKEN",
        generate: generateGatewayToken,
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
        // For auto-generated tokens, reuse the live value unless --rotate-tokens
        // so re-running populate doesn't rotate a token out from under services.
        let data = r.data;
        if (r.autoTokenKey && r.generate) {
          const token = await resolveAutoToken(
            interactiveClient,
            r.secretName,
            r.autoTokenKey,
            r.generate,
            options.rotateTokens ?? false
          );
          data = { [r.autoTokenKey]: token };
        }
        try {
          await interactiveClient!.send(new PutSecretValueCommand({
            SecretId: r.secretName,
            SecretString: JSON.stringify(data),
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
    const slackName = slackSecretName(fleetName, agentId);
    const slackRes = resolveSlack(agentId, rawAgentSlack(agent), env);
    if (slackRes.ok) {
      await emitSecret(results, client, options.dryRun,
        { agentId, secretType: "slack", secretName: slackName },
        slackRes.values);
    } else {
      results.push({ agentId, secretType: "slack", secretName: slackName, ok: false, missing: slackRes.missing });
    }

    // ── Model-provider keys — fan out: one Secrets Manager secret per
    //    (agent, provider). Each holds { <PROVIDER>_API_KEY: <value> }. ────────
    for (const provider of agentProviders(agent, defaultsModel)) {
      const secretName = providerSecretName(fleetName, agentId, provider);
      const res = resolveProviderKey(agentId, provider, agent.api_keys, env);
      const keyVar = providerApiKeyVar(provider);
      if (res.ok) {
        await emitSecret(results, client, options.dryRun,
          { agentId, secretType: `provider:${provider}`, secretName },
          { [keyVar]: res.value! });
      } else {
        results.push({
          agentId,
          secretType: `provider:${provider}`,
          secretName,
          ok: false,
          missing: res.missing,
        });
      }
    }

    // ── Hooks token — auto-generated, but preserved across re-runs unless
    //    --rotate-tokens (idempotent: reuse the live token if one exists). ─────
    const hooksName = hooksSecretName(fleetName, agentId);
    const hooksToken = await resolveAutoToken(
      client, hooksName, "HOOKS_TOKEN", generateHooksToken, options.rotateTokens ?? false);
    await emitSecret(results, client, options.dryRun,
      { agentId, secretType: "hooks", secretName: hooksName },
      { HOOKS_TOKEN: hooksToken });

    // ── Gateway auth token — auto-generated, but preserved across re-runs unless
    //    --rotate-tokens (idempotent: reuse the live token if one exists). ─────
    const gatewayName = gatewaySecretName(fleetName, agentId);
    const gatewayToken = await resolveAutoToken(
      client, gatewayName, "GATEWAY_TOKEN", generateGatewayToken, options.rotateTokens ?? false);
    await emitSecret(results, client, options.dryRun,
      { agentId, secretType: "gateway", secretName: gatewayName },
      { GATEWAY_TOKEN: gatewayToken });
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
