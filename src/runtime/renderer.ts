/**
 * FleetMind renderer — generates openclaw.json and terraform vars from fleet config.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { Fleet, AgentConfig } from "../config/schema.js";
import { slackChannel } from "../core/channels.js";
import { modelProvider } from "../core/model-provider.js";

/** An OpenClaw model config object. `fallbacks` is omitted when empty so strict
 *  (no-fallback) agents keep the bare `{ primary }` shape OpenClaw treats as
 *  strict. See OpenClaw docs/concepts/model-failover. */
function modelConfig(primary: string, fallbacks: string[]): { primary: string; fallbacks?: string[] } {
  return fallbacks.length > 0 ? { primary, fallbacks } : { primary };
}

/** Fallback models materialized into an agent's model config: the agent's own
 *  list when set (including an explicit [] = strict), else the fleet default. */
function agentFallbacks(agent: AgentConfig, defaults: Fleet["agents"]["defaults"]): string[] {
  return agent.fallback_models ?? defaults.fallback_models ?? [];
}

/** Every model ref an agent uses: its primary (or the fleet default) + its
 *  fallback chain. */
function agentModels(agent: AgentConfig, defaults: Fleet["agents"]["defaults"]): string[] {
  return [agent.model ?? defaults.model, ...agentFallbacks(agent, defaults)];
}

/**
 * Build the `agents.defaults.models` map for a set of agents, or undefined when
 * empty. Merges two things:
 *  - per-model param overrides from `agents.defaults.models` (e.g. cacheRetention)
 *  - an `agentRuntime: { id: "openclaw" }` override for every `openai/*` model
 *    used. OpenClaw routes `openai/*` to the Codex (subscription/OAuth) harness
 *    by default; forcing the openclaw runtime is what makes the injected
 *    OPENAI_API_KEY actually used (see OpenClaw docs/providers/openai).
 */
function buildModelsMap(
  agents: AgentConfig[],
  defaults: Fleet["agents"]["defaults"]
): Record<string, Record<string, unknown>> | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [modelKey, override] of Object.entries(defaults.models ?? {})) {
    if (override.params) out[modelKey] = { params: override.params };
  }
  for (const agent of agents) {
    for (const ref of agentModels(agent, defaults)) {
      if (modelProvider(ref) === "openai") {
        out[ref] = { ...(out[ref] ?? {}), agentRuntime: { id: "openclaw" } };
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const OPENCLAW_CONTEXT_SAFETY_DEFAULTS = {
  contextLimits: {
    toolResultMaxChars: 6000,
  },
  contextPruning: {
    mode: "cache-ttl",
    ttl: "90s",
  },
  compaction: {
    reserveTokens: 60000,
    maxHistoryShare: 0.35,
    recentTurnsPreserve: 2,
    midTurnPrecheck: {
      enabled: true,
    },
    truncateAfterCompaction: true,
  },
  subagents: {
    archiveAfterMinutes: 15,
  },
};

/**
 * Build the per-agent openclaw.json slice for a single gateway/EC2 instance.
 *
 * Each dogfood EC2 runs one gateway process for one agent. That gateway only
 * has its own agent's Slack secret in its EnvironmentFile — so shipping the
 * full fleet-wide config is wrong. This function returns a config slice that
 * contains only what the named agent's gateway needs:
 *
 *  - agents.list:               only this agent's entry
 *  - bindings:                  only this agent's binding
 *  - channels.slack.accounts:   only this agent's Slack account
 *  - tools.agentToAgent.allow:  only entries where from === agentId
 *  - plugins.entries:           only this agent's plugin list
 *  - Everything else (hooks, gateway, session, channels.slack top-level,
 *    commands) is passed through unchanged.
 */
export function renderAgentOpenClawJson(
  fleet: Fleet,
  agentId: string
): Record<string, unknown> {
  const { agents, openclaw } = fleet;
  const defaults = agents.defaults;
  const oc = openclaw;

  const agent = agents.list.find((a) => a.id === agentId);
  if (!agent) {
    throw new Error(`renderAgentOpenClawJson: agent "${agentId}" not found in fleet`);
  }
  const slack = slackChannel(agent);

  // Agent list — single entry for this agent only.
  // Workspace base comes from the agent's resolved runtime target.
  const agentWorkspaceBase = fleet.targetForAgent(agent).workspace_base;
  const workspace = `${agentWorkspaceBase}/${agent.id}`;
  const agentDir = `${agentWorkspaceBase}/agents/${agent.id}/agent`;
  const agentListEntry = {
    id: agent.id,
    name: agent.name,
    workspace,
    agentDir,
    model: modelConfig(agent.model ?? defaults.model, agentFallbacks(agent, defaults)),
    ...(agent.orchestrator ? { default: true } : {}),
  };

  // Bindings — only this agent's binding
  const bindings = [
    {
      agentId: agent.id,
      match: {
        channel: "slack",
        accountId: slack?.account_id,
      },
    },
  ];

  // Slack accounts — only this agent's account (no groupPolicy here; it lives at top level)
  const slackAccounts: Record<string, unknown> = {
    [slack?.account_id ?? agent.id]: {
      enabled: true,
      botToken: slack?.bot_token,
      appToken: slack?.app_token,
      webhookPath: `/slack/${slack?.account_id}`,
    },
  };

  // Per-channel config — derive inter-bot users allowlists
  // For each channel this agent operates in, find all OTHER agents that share it
  // and collect their bot_user_id values for the users allowlist.
  const perChannelEntries: Record<string, unknown> = {};
  // Filter out placeholder channel IDs — they break Slack channel startup.
  const agentChannels = (slack?.channels ?? []).filter(
    (c) => /^C[A-Z0-9]+$/.test(c)
  );
  for (let i = 0; i < agentChannels.length; i++) {
    const channelId = agentChannels[i]!;
    const requireMention = i > 0; // first channel = home, always responsive
    const botUserIds: string[] = [];
    for (const other of agents.list) {
      if (other.id === agentId) continue;
      const otherSlack = slackChannel(other);
      const otherChannels = otherSlack?.channels ?? [];
      if (!otherChannels.includes(channelId)) continue;
      if (!otherSlack?.bot_user_id) {
        process.stderr.write(
          `[fleetmind renderer] WARNING: agent "${other.id}" shares channel ${channelId} with "${agentId}" but has no bot_user_id — skipping bot-specific users allowlist entry for that agent.\n`
        );
        continue;
      }
      botUserIds.push(otherSlack.bot_user_id);
    }
    // Always include "*" wildcard so human users are never blocked by the per-channel
    // users allowlist. OpenClaw's authorizeSlackBotRoomMessage filters out "*" from the
    // bot-identity check, so only bot messages gate on the specific user_ids listed.
    const usersList = [...botUserIds, "*"];
    perChannelEntries[channelId] = {
      allowBots: true,
      enabled: true,
      requireMention,
      users: usersList,
    };
  }

  // agentToAgent allow list — array of target agent-id strings (per OpenClaw config schema).
  // The per-agent slice already contains only THIS agent's send targets from fleet.yaml,
  // so no from-filtering is needed here.
  const a2aAllow = [...new Set(agent.agent_to_agent.can_send_to)].sort();

  // Plugins — this agent's list (fall back to fleet defaults)
  // Always include 'slack' when a Slack channel is configured — it must be
  // registered in plugins.entries so OpenClaw discovers the installed channel
  // provider (@openclaw/slack). Without this it silently skips Slack startup.
  const agentPlugins = agent.plugins ?? defaults.plugins;
  const pluginEntries: Record<string, unknown> = {};
  for (const plugin of [...agentPlugins].sort()) {
    pluginEntries[plugin] = { enabled: true };
  }
  pluginEntries["slack"] = { enabled: true };
  // Webhooks plugin — NATS subscriber wake endpoint.
  // The NATS subscriber POSTs create_flow to /plugins/webhooks/nats-wake with
  // Authorization: Bearer ${OPENCLAW_HOOKS_TOKEN}. The gateway validates it
  // against the same OPENCLAW_HOOKS_TOKEN env var in its EnvironmentFile.
  pluginEntries["webhooks"] = {
    enabled: true,
    config: {
      routes: {
        "nats-wake": {
          path: "/plugins/webhooks/nats-wake",
          sessionKey: `agent:${agentId}:main`,
          secret: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_HOOKS_TOKEN",
          },
          description: "NATS subscriber wake endpoint — internal only",
        },
      },
    },
  };
  // agents.defaults.params — forward cacheRetention (and any future top-level params)
  // agents.defaults.models — forward per-model param overrides (e.g. long TTL for Sonnet)
  const defaultsParams = defaults.params && Object.keys(defaults.params).length > 0
    ? defaults.params
    : undefined;
  // Per-model overrides: defaults.models params + openai/* agentRuntime routing.
  const modelsMap = buildModelsMap([agent], defaults);

  // Hooks config — fall back to sensible defaults when oc.hooks is absent
  // (fleet objects built without going through FleetSchema.parse may omit it).
  const hooksConfig = oc.hooks ?? { enabled: true, path: "/hooks", allowed_agent_ids: ["main"] };
  // Canonical env var used by both the gateway (hooks.token + webhooks plugin secret)
  // and the NATS subscriber (wakeAgent). Written by fetch-agent-secrets from the
  // <fleet>/agents/<agent>/hooks Secrets Manager secret as OPENCLAW_HOOKS_TOKEN.
  const hooksTokenVar = "${OPENCLAW_HOOKS_TOKEN}";

  return {
    agents: {
      defaults: {
        model: modelConfig(defaults.model, defaults.fallback_models ?? []),
        timeoutSeconds: defaults.timeout_seconds,
        ...OPENCLAW_CONTEXT_SAFETY_DEFAULTS,
        ...(defaultsParams ? { params: defaultsParams } : {}),
        ...(modelsMap ? { models: modelsMap } : {}),
      },
      list: [agentListEntry],
    },
    bindings,
    tools: {
      profile: oc.tools.profile,
      agentToAgent: {
        enabled: true,
        allow: a2aAllow,
      },
      web: {
        search: {
          enabled: oc.tools.web_search.enabled,
          provider: oc.tools.web_search.provider,
        },
      },
    },
    session: {
      dmScope: oc.session.dm_scope,
    },
    messages: {
      visibleReplies: "automatic",
      groupChat: { visibleReplies: "automatic" },
    },
    channels: {
      slack: {
        mode: oc.slack.mode,
        enabled: true,
        groupPolicy: "allowlist",
        typingReaction: oc.slack.typing_reaction,
        ackReaction: oc.slack.ack_reaction,
        allowBots: oc.slack.allow_bots,
        historyLimit: oc.slack.history_limit,
        streaming: {
          mode: oc.slack.streaming.mode,
          nativeTransport: oc.slack.streaming.native_transport,
        },
        replyToModeByChatType: {
          channel: oc.slack.reply_to_mode_by_chat_type.channel,
        },
        accounts: slackAccounts,
        ...(Object.keys(perChannelEntries).length > 0 ? { channels: perChannelEntries } : {}),
      },
    },
    gateway: {
      port: oc.gateway.port,
      mode: oc.gateway.mode,
      bind: oc.gateway.bind,
      auth: {
        mode: "token",
        // Token generated at bootstrap and stored in Secrets Manager.
        // fetch-agent-secrets writes it to the env file as <AGENT_UPPER>_GATEWAY_TOKEN.
        token: `\${${agentId.toUpperCase().replace(/-/g, "_")}_GATEWAY_TOKEN}`,
      },
    },
    hooks: {
      // Webhook endpoint config for this agent.
      // token is generated at bootstrap, stored in Secrets Manager under
      // <fleet>/agents/<agent>/hooks, and injected as OPENCLAW_HOOKS_TOKEN
      // by fetch-agent-secrets. Must be distinct from gateway.auth.token
      // (OpenClaw enforces this at startup).
      enabled: hooksConfig.enabled,
      token: hooksTokenVar,
      path: hooksConfig.path,
      ...(hooksConfig.allowed_agent_ids.length > 0
        ? { allowedAgentIds: hooksConfig.allowed_agent_ids }
        : {}),
      internal: {
        enabled: true,
        entries: {
          "boot-md": { enabled: true },
          "session-memory": { enabled: true },
          "command-logger": { enabled: true },
        },
      },
    },
    plugins: {
      // allow list prevents "non-bundled plugins may auto-load" warning.
      allow: ["slack", "webhooks"],
      entries: pluginEntries,
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: true,
    },
  };
}

/**
 * @deprecated Use renderAgentOpenClawJson(fleet, agentId) instead.
 *
 * Returns a single fleet-wide openclaw.json with all agents, all bindings,
 * and all Slack accounts merged together. This shape targets a future
 * "one gateway, N agents" topology — it does NOT match the dogfood deploy
 * (one gateway per agent EC2). Kept for backward compatibility only.
 */
/** The agents whose runtime target resolves to `targetId` — i.e. the agents
 *  that run on that one host. Used to render a single gateway's config. */
export function agentsForTarget(fleet: Fleet, targetId: string): AgentConfig[] {
  return fleet.agents.list.filter((a) => fleet.targetForAgent(a).id === targetId);
}

/** Render a complete openclaw.json for one gateway hosting `hostAgents`.
 *  `renderOpenClawJson` passes the whole fleet (single-gateway / dev); a
 *  per-host deploy passes just the agents on that host. Only the listed agents'
 *  Slack accounts + tokens land in the config, so each host's gateway sees only
 *  its own credentials. */
function renderOpenClawJsonForAgents(fleet: Fleet, hostAgents: AgentConfig[]): Record<string, unknown> {
  const { agents, openclaw } = fleet;
  const defaults = agents.defaults;
  const oc = openclaw;

  // Agent list
  const agentList = hostAgents.map((agent) => {
    const model = agent.model ?? defaults.model;
    const agentWorkspaceBase = fleet.targetForAgent(agent).workspace_base;
    const workspace = `${agentWorkspaceBase}/${agent.id}`;
    const agentDir = `${agentWorkspaceBase}/agents/${agent.id}/agent`;
    return {
      id: agent.id,
      name: agent.name,
      workspace,
      agentDir,
      model: modelConfig(model, agentFallbacks(agent, defaults)),
      ...(agent.orchestrator ? { default: true } : {}),
    };
  });

  // Bindings: one per agent, matched on Slack accountId
  const bindings = hostAgents.map((agent) => ({
    agentId: agent.id,
    match: {
      channel: "slack",
      accountId: slackChannel(agent)?.account_id,
    },
  }));

  // Slack accounts (no per-account groupPolicy; lives at top level as "allowlist")
  const slackAccounts: Record<string, unknown> = {};
  for (const agent of hostAgents) {
    const slack = slackChannel(agent);
    slackAccounts[slack?.account_id ?? agent.id] = {
      enabled: true,
      botToken: slack?.bot_token,
      appToken: slack?.app_token,
      webhookPath: `/slack/${slack?.account_id}`,
    };
  }

  // agentToAgent allow list — array of target agent-id strings (per OpenClaw config schema).
  // Deduplicated and sorted for stable output.
  const a2aAllowSet = new Set<string>();
  for (const agent of hostAgents) {
    for (const targetId of agent.agent_to_agent.can_send_to) {
      a2aAllowSet.add(targetId);
    }
  }
  const a2aAllow = [...a2aAllowSet].sort();

  // Collect all plugins across agents
  const allPlugins = new Set<string>();
  for (const agent of hostAgents) {
    const plugins = agent.plugins ?? defaults.plugins;
    for (const p of plugins) allPlugins.add(p);
  }
  const pluginEntries: Record<string, unknown> = {};
  for (const plugin of [...allPlugins].sort()) {
    pluginEntries[plugin] = { enabled: true };
  }

  const modelsMap = buildModelsMap(hostAgents, defaults);
  return {
    agents: {
      defaults: {
        model: modelConfig(defaults.model, defaults.fallback_models ?? []),
        ...OPENCLAW_CONTEXT_SAFETY_DEFAULTS,
        ...(modelsMap ? { models: modelsMap } : {}),
      },
      list: agentList,
    },
    bindings,
    tools: {
      profile: oc.tools.profile,
      agentToAgent: {
        enabled: true,
        allow: a2aAllow,
      },
      web: {
        search: {
          enabled: oc.tools.web_search.enabled,
          provider: oc.tools.web_search.provider,
        },
      },
    },
    session: {
      dmScope: oc.session.dm_scope,
    },
    messages: {
      visibleReplies: "automatic",
      groupChat: { visibleReplies: "automatic" },
    },
    channels: {
      slack: {
        mode: oc.slack.mode,
        enabled: true,
        groupPolicy: "allowlist",
        typingReaction: oc.slack.typing_reaction,
        ackReaction: oc.slack.ack_reaction,
        allowBots: oc.slack.allow_bots,
        historyLimit: oc.slack.history_limit,
        streaming: {
          mode: oc.slack.streaming.mode,
          nativeTransport: oc.slack.streaming.native_transport,
        },
        replyToModeByChatType: {
          channel: oc.slack.reply_to_mode_by_chat_type.channel,
        },
        accounts: slackAccounts,
      },
    },
    gateway: {
      port: oc.gateway.port,
      mode: oc.gateway.mode,
      bind: oc.gateway.bind,
    },
    hooks: {
      internal: {
        enabled: true,
        entries: {
          "boot-md": { enabled: true },
          "session-memory": { enabled: true },
          "command-logger": { enabled: true },
        },
      },
    },
    plugins: {
      // allow list prevents "non-bundled plugins may auto-load" warning.
      allow: ["slack"],
      entries: pluginEntries,
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: true,
    },
  };
}

/** Full-fleet openclaw.json (every agent in one gateway). Used by `deploy`
 *  (local ./rendered output) and dev. */
export function renderOpenClawJson(fleet: Fleet): Record<string, unknown> {
  return renderOpenClawJsonForAgents(fleet, fleet.agents.list);
}

/** openclaw.json for the single gateway on one host: exactly the agents whose
 *  `target` resolves to `targetId`. A one-agent host yields the same shape as
 *  the legacy per-agent slice; an n-agent host yields one multi-agent gateway. */
export function renderHostOpenClawJson(fleet: Fleet, targetId: string): Record<string, unknown> {
  return renderOpenClawJsonForAgents(fleet, agentsForTarget(fleet, targetId));
}

export function renderTerraformVars(fleet: Fleet): string {
  const agentNames = fleet.agents.list.map((a) => `"${a.id}"`).join(", ");

  // Derive agent_orchestrators map from fleet.yaml. Drives task-ledger's IAM
  // policy split (pm vs worker), wake target Name tag derivation, and NATS mode selection.
  // Operators must use this map in their bootstrap template to conditionally set NATS_MODE:
  //   NATS_MODE=${agent_orchestrators[agent_id] ? "pm" : "worker"}
  const orchestratorEntries = fleet.agents.list
    .map((a) => `  ${a.id} = ${a.orchestrator ? "true" : "false"}`)
    .join("\n");

  // Derive agent_providers map from each agent's explicit `providers:` list in
  // fleet.yaml. terraform-aws-fleetmind (>= v0.5.0) requires a non-empty list
  // per agent and will fail validation if any entry is empty — we forward the
  // declaration verbatim (no inference) and let TF surface the missing-field
  // error on apply. The CLI runtime ALSO hard-fails through providersForAgent()
  // before any secret operation, so the message lands at the user even when
  // they never run terraform.
  const providerEntries = fleet.agents.list
    .map((a) => {
      const provs = (a as { providers?: string[] }).providers ?? [];
      const items = provs.map((p) => `"${String(p).toLowerCase()}"`).join(", ");
      return `  ${a.id} = [${items}]`;
    })
    .join("\n");

  const lines = [
    `# Auto-generated by FleetMind — do not edit manually`,
    `# Fleet: ${fleet.fleet.name} v${fleet.fleet.version}`,
    ``,
    `fleet_name  = "${fleet.fleet.name}"`,
    `agent_names = [${agentNames}]`,
    ``,
    `# PM (orchestrator) flag per agent — drives task-ledger IAM policy split.`,
    `agent_orchestrators = {`,
    orchestratorEntries,
    `}`,
    ``,
    `# Per-agent model providers (drives per-provider Secrets Manager secrets`,
    `# at <fleet>/agents/<agent>/providers/<provider>). REQUIRED.`,
    `agent_providers = {`,
    providerEntries,
    `}`,
    ``,
    `# NOTE: instance_type, aws_region, and other infrastructure vars are not`,
    `# derived from fleet.yaml — set them in your workspace tfvars manually.`,
    `# See infra/terraform/variables.tf for all available variables.`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Resolve the base directory for per-agent openclaw.json output files.
 *
 * Schema decision: `fleet.outputs.openclaw_json` is treated as follows:
 *  - If it ends with `.json` (legacy single-file path, e.g. `./rendered/openclaw.json`):
 *    strip the `.json` extension and use the result as the base directory.
 *    → `./rendered/openclaw.json` becomes `./rendered/openclaw/`
 *  - Otherwise treat the value as a directory path directly.
 *    → `./rendered/openclaw` is used as-is.
 *
 * Per-agent files are then written as `<baseDir>/<agent_id>/openclaw.json`.
 * This is backward-compatible: existing fleet.yaml files that use the default
 * `./rendered/openclaw.json` will silently produce the new per-agent layout
 * at `./rendered/openclaw/<agent_id>/openclaw.json` without any config change.
 */
export function resolveOpenClawBaseDir(ocJsonPath: string, baseDir: string): string {
  const resolved = path.resolve(baseDir, ocJsonPath);
  if (resolved.endsWith(".json")) {
    return resolved.slice(0, -".json".length);
  }
  return resolved;
}

export function resolveTerraformVarsPath(fleet: Fleet, baseDir: string): string {
  // Auto-derive tfvars path from fleet name when the operator hasn't set
  // outputs.terraform_vars explicitly (i.e. it still has the schema default).
  // Result: ./workspaces/<fleet-name>.derived.tfvars
  const DEFAULT_TF_VARS = "./rendered/fleet.derived.tfvars";
  const resolvedTfVars =
    fleet.outputs.terraform_vars === DEFAULT_TF_VARS
      ? `./workspaces/${fleet.fleet.name}.derived.tfvars`
      : fleet.outputs.terraform_vars;
  return path.resolve(baseDir, resolvedTfVars);
}

export function writeOutputs(
  fleet: Fleet,
  baseDir: string = "."
): Record<string, string> {
  const written: Record<string, string> = {};

  // Per-agent openclaw.json files
  // Layout: <ocBase>/<agent_id>/openclaw.json
  // e.g. ./rendered/openclaw/conductor/openclaw.json
  const ocBase = resolveOpenClawBaseDir(fleet.outputs.openclaw_json, baseDir);
  const agentPaths: Record<string, string> = {};
  for (const agent of fleet.agents.list) {
    const agentOcPath = path.join(ocBase, agent.id, "openclaw.json");
    const agentOcBasePath = path.join(ocBase, agent.id, "openclaw.base.json");
    fs.mkdirSync(path.dirname(agentOcPath), { recursive: true });
    const rendered = renderAgentOpenClawJson(fleet, agent.id);
    const renderedJson = JSON.stringify(rendered, null, 2);
    fs.writeFileSync(agentOcPath, renderedJson);
    // openclaw.base.json — required by OpenClaw 2026.5.19+ as a baseline
    // config reference. Without it, gateway refuses to start. Write the same
    // content as openclaw.json so the security check always passes.
    fs.writeFileSync(agentOcBasePath, renderedJson);
    agentPaths[agent.id] = agentOcPath;
    written[`openclaw_json:${agent.id}`] = agentOcPath;
  }

  const tfPath = resolveTerraformVarsPath(fleet, baseDir);

  // Guard against the multi-workspace cross-contamination footgun:
  // *.auto.tfvars at the Terraform working directory (infra/terraform/<file>.auto.tfvars)
  // is auto-loaded by `terraform apply` regardless of which workspace is selected.
  // If render writes there, a different fleet's render can silently clobber it,
  // and operators applying the OTHER workspace pick up the wrong fleet's values.
  // Per-workspace files under infra/terraform/workspaces/ are NOT auto-loaded
  // (subdirectory) and must be passed via -var-file explicitly — safe.
  if (tfPath.endsWith(".auto.tfvars") && tfPath.includes(`${path.sep}infra${path.sep}terraform${path.sep}`)) {
    const tfDir = path.dirname(tfPath);
    const isInWorkspacesSubdir = tfDir.endsWith(`${path.sep}workspaces`);
    if (!isInWorkspacesSubdir) {
      throw new Error(
        `Refusing to write rendered tfvars to ${tfPath}.\n` +
        `Files matching infra/terraform/*.auto.tfvars are auto-loaded by Terraform regardless\n` +
        `of the selected workspace — a known cross-workspace contamination footgun.\n` +
        `\n` +
        `Fix: in fleet.yaml, change outputs.terraform_vars to:\n` +
        `  ./infra/terraform/workspaces/<fleet-name>.derived.tfvars\n` +
        `\n` +
        `Pass it explicitly to terraform apply via -var-file. See docs/MULTI-FLEET.md.`
      );
    }
  }

  fs.mkdirSync(path.dirname(tfPath), { recursive: true });
  fs.writeFileSync(tfPath, renderTerraformVars(fleet));
  written["terraform_vars"] = tfPath;

  // Per-agent fleet.yaml slices — written to rendered/workspaces/<agent>/fleet.yaml.
  // Each slice contains only what that agent needs: global fleet config, its own
  // agent entry, and the fleet roster (other agents' id/name/channels for
  // delegation routing) but NOT other agents' credentials or token references.
  const wsBase = path.resolve(baseDir, fleet.outputs.workspace_manifests);
  for (const agent of fleet.agents.list) {
    const agentWsDir = path.join(wsBase, agent.id);
    fs.mkdirSync(agentWsDir, { recursive: true });
    const slicePath = path.join(agentWsDir, "fleet.yaml");
    fs.writeFileSync(slicePath, renderAgentFleetYaml(fleet, agent.id));
    written[`fleet_yaml:${agent.id}`] = slicePath;
  }

  // ── Fleet-wide COMPANY.md distribution ──────────────────────────────────
  // If the operator has a COMPANY.md at the fleet repo root (next to
  // fleet.yaml), copy it into every per-agent rendered workspace. This is
  // shared org context that every bot in the fleet reads at startup.
  // Absent COMPANY.md is fine — just skip silently. The agents' AGENTS.md
  // tells them to only read COMPANY.md "if it exists."
  const companyMdPath = path.resolve(baseDir, "COMPANY.md");
  if (fs.existsSync(companyMdPath)) {
    const companyContent = fs.readFileSync(companyMdPath, "utf-8");
    for (const agent of fleet.agents.list) {
      const agentWsDir = path.join(wsBase, agent.id);
      const destPath = path.join(agentWsDir, "COMPANY.md");
      fs.writeFileSync(destPath, companyContent);
      written[`company_md:${agent.id}`] = destPath;
    }
  }

  return written;
}

/**
 * Render a per-agent fleet.yaml slice containing only what that agent needs:
 * - Global fleet config (name, version, delegation table/bucket/region)
 * - This agent's own entry (id, role, skills, persona, orchestrator flag)
 * - Fleet roster: other agents' id, name, channels (for delegation routing)
 *   but NOT their bot_token, app_token, signing_secret, or any credentials
 */
export function renderAgentFleetYaml(fleet: Fleet, agentId: string): string {
  const agent = fleet.agents.list.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found in fleet`);

  // Roster: other agents with only routing-safe fields. Each carries its
  // `target` so the slice re-parses (normalizeFleet resolves every agent's
  // target against the included `targets` map below). Credentials and channel
  // bindings are deliberately omitted.
  const roster = fleet.agents.list
    .filter((a) => a.id !== agentId)
    .map((a) => ({
      id: a.id,
      name: a.name,
      emoji: a.emoji,
      role: a.role,
      orchestrator: a.orchestrator ?? false,
      ...(a.target ? { target: a.target } : {}),
    }));

  // Derive NATS server URL from fleet name if not explicitly set.
  // Convention: nats://nats.<fleet_name>.internal:4222 (Cloud Map registration).
  // This means operators never hardcode infra-specific URLs in fleet.yaml.
  let delegation = fleet.delegation;
  if (delegation?.nats && (!delegation.nats.servers || delegation.nats.servers.length === 0)) {
    delegation = {
      ...delegation,
      nats: {
        ...delegation.nats,
        servers: [`nats://nats.${fleet.fleet.name}.internal:4222`],
      },
    };
  }

  const selfEntry = {
    id: agent.id,
    name: agent.name,
    emoji: agent.emoji,
    role: agent.role,
    orchestrator: agent.orchestrator ?? false,
    model: agent.model ?? fleet.agents.defaults.model,
    ...(agent.fallback_models ? { fallback_models: agent.fallback_models } : {}),
    skills: agent.skills ?? [],
    ...(agent.target ? { target: agent.target } : {}),
    ...(agent.delegation ? { delegation: agent.delegation } : {}),
    // Include the agent's `channels:` block in the slice. The fleetmind NATS
    // subscriber (`fleetmind nats subscribe`) reads this slice and needs the
    // channels block to resolve the worker's home Slack channel for the
    // fast-path ack + session-key routing (see `resolveWorkerHomeChannel` in
    // src/cli/commands/nats.ts). Tokens stay as `${VAR}` references and are
    // resolved on the bot side via the systemd unit's `EnvironmentFile=`.
    // Stripping channels here used to leave the subscriber unable to find
    // the worker's home channel — the wake silently fell back to delegation_thread.
    ...((agent as { channels?: unknown }).channels ? { channels: (agent as { channels: unknown }).channels } : {}),
  };

  const slice = {
    fleet: {
      name: fleet.fleet.name,
      version: fleet.fleet.version,
    },
    ...(delegation ? { delegation } : {}),
    // Runtime targets are host config (no secrets); included so the slice
    // re-parses on the bot side, where every agent's target must resolve.
    targets: fleet.targets,
    ...(fleet.context ? { context: fleet.context } : {}),
    agents: {
      defaults: {
        model: fleet.agents.defaults.model,
        ...(fleet.agents.defaults.fallback_models ? { fallback_models: fleet.agents.defaults.fallback_models } : {}),
        ...(fleet.agents.defaults.target ? { target: fleet.agents.defaults.target } : {}),
      },
      self: selfEntry,
      roster,
      // agents.list satisfies FleetSchema required by fleetmind CLI commands
      // (e.g. nats subscribe). Contains this agent + routing-safe roster entries.
      list: [selfEntry, ...roster],
    },
  };

  return [
    `# Auto-generated by FleetMind — do not edit manually`,
    `# Agent: ${agentId} | Fleet: ${fleet.fleet.name} v${fleet.fleet.version}`,
    `# This is a per-agent slice. For the full fleet config see the operator repo.`,
    ``,
    yamlStringify(slice, { lineWidth: 120 }),
  ].join("\n");
}
