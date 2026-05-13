/**
 * `fleetmind slack` — Slack utilities for fleet agents.
 *
 * Subcommands:
 *   discover    Auto-populate bot_user_id for each agent from Secrets Manager.
 *   manifests   Generate per-agent Slack App manifest YAMLs from fleet.yaml.
 */

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { parseDocument } from "yaml";
import chalk from "chalk";
import { log } from "../../utils/log.js";

// ── Dependency-injection interfaces ──────────────────────────────────────────

/** Minimal interface for Secrets Manager — injectable for tests. */
export interface SmSendable {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

/** HTTP fetch signature — injectable for tests. */
export type HttpFn = (
  url: string,
  opts: { method: string; headers: Record<string, string> }
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** File-write function — injectable for tests. */
export type WriteFn = (filePath: string, content: string) => void;

// ── Fleet YAML types ──────────────────────────────────────────────────────────

interface AgentSlack {
  bot_token?: string;
  bot_user_id?: string;
}

interface RawAgent {
  id?: string;
  name?: string;
  slack?: AgentSlack;
}

interface RawFleet {
  fleet?: { name?: string };
  delegation?: { aws_region?: string };
  agents?: { list?: RawAgent[] };
}

// ── Options & results ─────────────────────────────────────────────────────────

export interface DiscoverOptions {
  fleet: string;
  region: string;
  agent?: string[];
  dryRun: boolean;
  force: boolean;
  /** Injectable Secrets Manager client for unit tests. */
  smClient?: SmSendable;
  /** Injectable HTTP function for unit tests. */
  httpFn?: HttpFn;
  /** Injectable file-write function for unit tests. */
  writeFn?: WriteFn;
}

export interface AgentDiscoverResult {
  agentId: string;
  status: "discovered" | "skipped" | "failed";
  botUserId?: string;
  reason?: string;
}

export interface DiscoverResult {
  agents: AgentDiscoverResult[];
  /** Number of agents successfully discovered in this run. */
  discoveredCount: number;
  /** Number of agents skipped (already had bot_user_id and --force not set). */
  skippedCount: number;
  /** Number of agents that failed. */
  failedCount: number;
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Resolve the SLACK_BOT_TOKEN from a Secrets Manager secret JSON blob.
 * The secret is stored as JSON by `fleetmind secrets populate`.
 */
function extractBotToken(secretString: string): string | null {
  try {
    const parsed = JSON.parse(secretString) as Record<string, unknown>;
    const token = parsed["SLACK_BOT_TOKEN"];
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * Call Slack auth.test and return the bot user_id (U…).
 */
async function callAuthTest(
  token: string,
  httpFn: HttpFn
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  try {
    const resp = await httpFn("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const body = (await resp.json()) as { ok: boolean; user_id?: string; error?: string };
    if (!body.ok) {
      return { ok: false, error: body.error ?? "unknown_error" };
    }
    if (!body.user_id) {
      return { ok: false, error: "auth.test returned ok but no user_id" };
    }
    return { ok: true, userId: body.user_id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `network error: ${msg}` };
  }
}

/**
 * Write updated bot_user_id values back into fleet.yaml while preserving
 * comments and formatting, using the `yaml` package's document-level API.
 */
export function writeFleetYaml(
  fleetPath: string,
  updates: Map<string, string>,
  writeFn: WriteFn
): void {
  const raw = fs.readFileSync(fleetPath, "utf-8");
  const doc = parseDocument(raw);

  // Navigate: agents.list[*].slack.bot_user_id
  const agentsNode = doc.getIn(["agents", "list"]);
  if (!agentsNode || !("items" in (agentsNode as object))) {
    throw new Error("fleet.yaml: agents.list is missing or not a sequence");
  }

  // Iterate using the yaml document's own sequence items
  const listSeq = agentsNode as { items: unknown[] };
  for (let i = 0; i < listSeq.items.length; i++) {
    const idVal = doc.getIn(["agents", "list", i, "id"]) as string | undefined;
    if (!idVal || !updates.has(idVal)) continue;

    const newUserId = updates.get(idVal)!;

    // Check if slack map exists
    const slackExists = doc.hasIn(["agents", "list", i, "slack"]);
    if (!slackExists) {
      // Create a minimal slack map — shouldn't normally happen if populate ran first
      doc.setIn(["agents", "list", i, "slack"], { bot_user_id: newUserId });
    } else {
      doc.setIn(["agents", "list", i, "slack", "bot_user_id"], newUserId);
    }
  }

  writeFn(fleetPath, doc.toString());
}

/**
 * Main discovery logic. Reads fleet.yaml, fetches secrets, calls auth.test,
 * and writes discovered bot_user_id values back.
 */
export async function discoverSlackBotUserIds(
  options: DiscoverOptions
): Promise<DiscoverResult> {
  const fleetPath = path.resolve(options.fleet);
  if (!fs.existsSync(fleetPath)) {
    throw new Error(`Fleet file not found: ${fleetPath}`);
  }

  // Parse fleet.yaml (js-yaml for reading — we use the yaml document API for writing)
  const { load } = await import("js-yaml");
  const rawFleet = load(fs.readFileSync(fleetPath, "utf-8")) as RawFleet;

  const fleetName = rawFleet?.fleet?.name;
  if (!fleetName) throw new Error("fleet.name is required in fleet.yaml");

  const agents = rawFleet?.agents?.list ?? [];
  if (agents.length === 0) throw new Error("No agents found in fleet.yaml");

  // Filter by --agent flags if provided
  const targetIds =
    options.agent && options.agent.length > 0 ? new Set(options.agent) : null;

  const filteredAgents = agents.filter(
    (a) => a.id && (!targetIds || targetIds.has(a.id))
  );

  const region =
    options.region ??
    rawFleet?.delegation?.aws_region ??
    "us-west-2";

  // Build SM client
  const smClient: SmSendable =
    options.smClient ?? new SecretsManagerClient({ region });

  // Default HTTP function
  const httpFn: HttpFn =
    options.httpFn ??
    (async (url, opts) => {
      const resp = await fetch(url, opts);
      return {
        ok: resp.ok,
        json: () => resp.json() as Promise<unknown>,
      };
    });

  // Default write function
  const writeFn: WriteFn = options.writeFn ?? ((p, content) => fs.writeFileSync(p, content, "utf-8"));

  const results: AgentDiscoverResult[] = [];
  /** Accumulated updates to write back to fleet.yaml. */
  const pendingUpdates = new Map<string, string>();

  for (const agent of filteredAgents) {
    const agentId = agent.id!;
    const existingUserId = agent.slack?.bot_user_id;

    // Skip if already set and --force not passed
    if (existingUserId && !options.force) {
      results.push({
        agentId,
        status: "skipped",
        botUserId: existingUserId,
        reason: "bot_user_id already set (use --force to overwrite)",
      });
      continue;
    }

    // Fetch secret from SM
    const secretName = `${fleetName}/agents/${agentId}/slack`;
    let botToken: string | null = null;

    try {
      const resp = await smClient.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
      if (!resp.SecretString) {
        log.warn(
          `${agentId}: secret ${secretName} has no SecretString — skipping`
        );
        results.push({
          agentId,
          status: "failed",
          reason: `secret ${secretName} has no SecretString`,
        });
        continue;
      }
      botToken = extractBotToken(resp.SecretString);
      if (!botToken) {
        log.warn(
          `${agentId}: SLACK_BOT_TOKEN not found in secret ${secretName} — skipping`
        );
        results.push({
          agentId,
          status: "failed",
          reason: `SLACK_BOT_TOKEN not found in secret ${secretName}`,
        });
        continue;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`${agentId}: could not fetch secret ${secretName}: ${msg} — skipping`);
      results.push({
        agentId,
        status: "failed",
        reason: `secret fetch failed: ${msg}`,
      });
      continue;
    }

    // Call auth.test
    const authResult = await callAuthTest(botToken, httpFn);
    if (!authResult.ok) {
      log.warn(
        `${agentId}: auth.test failed (${authResult.error}) — skipping`
      );
      results.push({
        agentId,
        status: "failed",
        reason: `auth.test error: ${authResult.error}`,
      });
      continue;
    }

    pendingUpdates.set(agentId, authResult.userId);
    results.push({
      agentId,
      status: "discovered",
      botUserId: authResult.userId,
    });
  }

  const discoveredCount = results.filter((r) => r.status === "discovered").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  // Dry-run: print proposed changes and return
  if (options.dryRun) {
    if (pendingUpdates.size === 0) {
      console.log(chalk.dim("(dry-run) No changes needed — all bot_user_id values already set."));
    } else {
      console.log(chalk.dim("\n(dry-run) Proposed changes to fleet.yaml:"));
      for (const [agentId, userId] of pendingUpdates) {
        console.log(chalk.dim(`  ${agentId}: bot_user_id → ${userId}`));
      }
      console.log();
    }
    return { agents: results, discoveredCount, skippedCount, failedCount };
  }

  // Write back to fleet.yaml
  if (pendingUpdates.size > 0) {
    try {
      writeFleetYaml(fleetPath, pendingUpdates, writeFn);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to write fleet.yaml: ${msg}`);
      process.exit(1);
    }
  }

  return { agents: results, discoveredCount, skippedCount, failedCount };
}

// ── Output formatting ─────────────────────────────────────────────────────────

export function printDiscoverResults(
  result: DiscoverResult,
  dryRun: boolean
): void {
  for (const r of result.agents) {
    if (r.status === "discovered") {
      const action = dryRun ? "(dry-run)" : "written";
      log.ok(`${r.agentId}: bot_user_id = ${chalk.cyan(r.botUserId!)} ${chalk.dim(action)}`);
    } else if (r.status === "skipped") {
      log.dim(`${r.agentId}: skipped — ${r.reason}`);
    } else {
      log.warn(`${r.agentId}: failed — ${r.reason}`);
    }
  }

  console.log();
  console.log(
    `  ${chalk.green(result.discoveredCount)} discovered, ` +
    `${chalk.dim(result.skippedCount)} skipped, ` +
    `${result.failedCount > 0 ? chalk.yellow(result.failedCount) : result.failedCount} failed`
  );
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerSlackDiscover(program: Command): void {
  const slack = program
    .command("slack")
    .description("Slack utilities for fleet agents")
    .addHelpText('after', `
Subcommands:
  discover    Auto-populate bot_user_id in fleet.yaml from Slack auth.test
  manifests   Generate per-agent Slack App manifest YAMLs

Run \`fleetmind slack <subcommand> --help\` for examples.
`);

  slack
    .command("discover")
    .description(
      "Fetch each agent's Slack bot token from Secrets Manager, call auth.test, " +
      "and write the discovered bot_user_id back into fleet.yaml"
    )
    .option("--fleet <path>", "fleet.yaml path", "./fleet.yaml")
    .option("--region <region>", "AWS region for Secrets Manager", "us-west-2")
    .option(
      "--agent <id>",
      "limit to specific agent (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--dry-run", "print proposed changes without writing fleet.yaml", false)
    .option(
      "--force",
      "overwrite existing bot_user_id values (default: skip agents that already have one)",
      false
    )
    .addHelpText('after', `
Examples:
  # Auto-fill bot_user_id for all agents (reads tokens from Secrets Manager)
  $ fleetmind slack discover

  # Discover for a single agent only
  $ fleetmind slack discover --agent pm-bot

  # Dry-run: show what would be written to fleet.yaml without writing
  $ fleetmind slack discover --dry-run

  # Force overwrite even when bot_user_id is already set in fleet.yaml
  $ fleetmind slack discover --force
`)
    .action(async (opts: {
      fleet: string;
      region: string;
      agent: string[];
      dryRun: boolean;
      force: boolean;
    }) => {
      try {
        const result = await discoverSlackBotUserIds({
          fleet: opts.fleet,
          region: opts.region,
          agent: opts.agent.length > 0 ? opts.agent : undefined,
          dryRun: opts.dryRun,
          force: opts.force,
        });

        printDiscoverResults(result, opts.dryRun);

        // Exit codes:
        // 0 — at least one agent discovered (even if others were skipped/failed)
        // 2 — dry-run with no changes needed (all bot_user_id already set)
        // 1 — all agents failed (no discoveries)
        if (result.discoveredCount === 0 && result.skippedCount > 0 && result.failedCount === 0) {
          // All were skipped — nothing to do
          if (opts.dryRun) {
            process.exit(2);
          }
        } else if (result.discoveredCount === 0 && result.failedCount > 0) {
          process.exit(1);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
      }
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// `fleetmind slack manifests` — generate per-agent Slack App manifest YAMLs
// ═════════════════════════════════════════════════════════════════════════════

import { stringify as yamlStringify } from "yaml";
import { resolveFleetSource } from "../../config/loader.js";

// ── Default background colours per agent role ─────────────────────────────────

/** Role → hex background colour for the Slack App manifest. */
export const ROLE_BACKGROUND_COLORS: Record<string, string> = {
  pm: "#003366",
  "backend-worker": "#8B4513",
  "frontend-worker": "#4B0082",
  worker: "#555555",
};

/** The default bot OAuth scopes included in every generated manifest. */
export const DEFAULT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "users:read",
  "files:read",
  "files:write",
];

/** The default bot event subscriptions included in every generated manifest. */
export const DEFAULT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
  "reaction_removed",
];

// ── Types ─────────────────────────────────────────────────────────────────────

/** Subset of the agent we need for manifest generation. */
export interface ManifestAgentInput {
  id: string;
  name: string;
  role?: string;
  description?: string;
  slack?: {
    long_description?: string;
    background_color?: string;
    extra_scopes?: string[];
    extra_events?: string[];
  };
}

/** A raw fleet.yaml-like shape for manifest generation (flexible, no Zod). */
export interface ManifestFleetInput {
  fleet?: { name?: string };
  agents?: { list?: ManifestAgentInput[] };
}

/** Options for the manifest generator. */
export interface ManifestsOptions {
  /** fleet.yaml path (passed via --fleet). */
  fleet?: string;
  /** Output directory (default: ./rendered/slack-manifests/). */
  out: string;
  /** Agent IDs to restrict generation to. Empty = all agents. */
  agent: string[];
  /** Injectable fs.mkdirSync equivalent for tests. */
  mkdirFn?: (p: string) => void;
  /** Injectable file-write function for tests. */
  writeFn?: (filePath: string, content: string) => void;
}

/** Result for a single agent's manifest write. */
export interface ManifestWriteResult {
  agentId: string;
  filePath: string;
}

/** Result for the full manifests run. */
export interface ManifestsResult {
  written: ManifestWriteResult[];
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Build the Slack App manifest object for a single agent.
 * Returns a plain JS object suitable for YAML serialisation.
 */
export function buildManifest(
  agent: ManifestAgentInput,
  fleetName: string
): Record<string, unknown> {
  const role = agent.role ?? "worker";
  const bgColor =
    agent.slack?.background_color ??
    ROLE_BACKGROUND_COLORS[role] ??
    ROLE_BACKGROUND_COLORS["worker"];

  // Build long_description: prefer explicit field, otherwise synthesise.
  const longDesc =
    agent.slack?.long_description ??
    `${agent.name} is a ${role} bot for the ${fleetName} fleet.\n` +
      `${agent.description ?? ""}`.trim();

  // Merge extra scopes (deduped, extras after defaults).
  const extraScopes = agent.slack?.extra_scopes ?? [];
  const scopes = [
    ...DEFAULT_SCOPES,
    ...extraScopes.filter((s) => !DEFAULT_SCOPES.includes(s)),
  ];

  // Merge extra events (deduped, extras after defaults).
  const extraEvents = agent.slack?.extra_events ?? [];
  const events = [
    ...DEFAULT_EVENTS,
    ...extraEvents.filter((e) => !DEFAULT_EVENTS.includes(e)),
  ];

  return {
    display_information: {
      name: agent.name,
      description: agent.description ?? "",
      background_color: bgColor,
      long_description: longDesc,
    },
    features: {
      bot_user: {
        display_name: agent.name,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: scopes,
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: events,
      },
      interactivity: {
        is_enabled: true,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Generate manifest YAMLs for all target agents and write them to disk.
 */
export async function generateManifests(
  options: ManifestsOptions
): Promise<ManifestsResult> {
  // Resolve fleet
  const fleetSource = resolveFleetSource(options.fleet);
  if (fleetSource.kind !== "file") {
    throw new Error(
      'slack manifests requires a fleet.yaml file — pass --fleet <path> or run from ' +
        'a directory containing fleet.yaml.'
    );
  }

  const { load } = await import("js-yaml");
  const raw = load(fs.readFileSync(fleetSource.path, "utf-8")) as ManifestFleetInput;

  const fleetName = raw?.fleet?.name;
  if (!fleetName) throw new Error("fleet.name is required in fleet.yaml");

  const agents = raw?.agents?.list ?? [];
  if (agents.length === 0) throw new Error("No agents found in fleet.yaml");

  const targetIds =
    options.agent.length > 0 ? new Set(options.agent) : null;

  const targets = agents.filter(
    (a) => a.id && (!targetIds || targetIds.has(a.id))
  );

  if (targets.length === 0) {
    throw new Error(
      `No agents matched filter: ${options.agent.join(", ")}`
    );
  }

  // Ensure output directory exists.
  const outDir = path.resolve(options.out);
  const mkdirFn =
    options.mkdirFn ??
    ((p: string) => fs.mkdirSync(p, { recursive: true }));
  mkdirFn(outDir);

  const writeFn: WriteFn =
    options.writeFn ??
    ((p, content) => fs.writeFileSync(p, content, "utf-8"));

  const written: ManifestWriteResult[] = [];

  for (const agent of targets) {
    const manifest = buildManifest(agent, fleetName);
    const yaml = yamlStringify(manifest, { lineWidth: 0 });
    const filePath = path.join(outDir, `${agent.id}.yaml`);
    writeFn(filePath, yaml);
    written.push({ agentId: agent.id, filePath });
  }

  return { written };
}

// ── Output formatting ─────────────────────────────────────────────────────────

export function printManifestsResult(result: ManifestsResult): void {
  console.log();
  for (const w of result.written) {
    log.ok(`${w.agentId}: ${chalk.cyan(w.filePath)}`);
  }
  console.log();
  console.log(
    `  ${chalk.green(result.written.length)} manifest${result.written.length !== 1 ? "s" : ""} written`
  );
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerSlackManifests(program: Command): void {
  // Re-use or find the existing `slack` subcommand if already registered.
  let slackCmd = program.commands.find((c) => c.name() === "slack");
  if (!slackCmd) {
    slackCmd = program
      .command("slack")
      .description("Slack utilities for fleet agents");
  }

  slackCmd
    .command("manifests")
    .description(
      "Generate per-agent Slack App manifest YAMLs from fleet.yaml. " +
      "Writes one <agent_id>.yaml per agent to the output directory."
    )
    .option("--fleet <path>", "fleet.yaml path (default: resolved via resolveFleetSource)")
    .option("--out <dir>", "output directory", "./rendered/slack-manifests/")
    .option(
      "--agent <id>",
      "limit to specific agent (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .addHelpText('after', `
Examples:
  # Generate Slack App manifests for all agents into ./rendered/slack-manifests/
  $ fleetmind slack manifests

  # Generate for a single agent only
  $ fleetmind slack manifests --agent pm-bot

  # Write manifests to a custom output directory
  $ fleetmind slack manifests --out ./slack-app-configs
`)
    .action(async (opts: { fleet?: string; out: string; agent: string[] }) => {
      try {
        const result = await generateManifests({
          fleet: opts.fleet,
          out: opts.out,
          agent: opts.agent,
        });
        printManifestsResult(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
      }
    });
}
