/**
 * FleetMind renderer — generates openclaw.json and terraform vars from fleet config.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { Fleet, AgentConfig } from "../config/schema.js";

/**
 * Build the per-agent openclaw.json slice for a single gateway/EC2 instance.
 *
 * Each gg-sandbox EC2 runs one gateway process for one agent. That gateway only
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

  // Agent list — single entry for this agent only
  const workspace = `${defaults.workspace_base}/${agent.id}`;
  const agentDir = `${defaults.workspace_base}/agents/${agent.id}/agent`;
  const agentListEntry = {
    id: agent.id,
    name: agent.name,
    workspace,
    agentDir,
    model: { primary: agent.model ?? defaults.model },
    ...(agent.orchestrator ? { default: true } : {}),
  };

  // Bindings — only this agent's binding
  const bindings = [
    {
      agentId: agent.id,
      match: {
        channel: "slack",
        accountId: agent.slack.account_id,
      },
    },
  ];

  // Slack accounts — only this agent's account (no groupPolicy here; it lives at top level)
  const slackAccounts: Record<string, unknown> = {
    [agent.slack.account_id]: {
      enabled: true,
      botToken: agent.slack.bot_token,
      appToken: agent.slack.app_token,
      webhookPath: `/slack/${agent.slack.account_id}`,
    },
  };

  // Per-channel config — derive inter-bot users allowlists
  // For each channel this agent operates in, find all OTHER agents that share it
  // and collect their bot_user_id values for the users allowlist.
  const perChannelEntries: Record<string, unknown> = {};
  const agentChannels = agent.slack.channels ?? [];
  for (let i = 0; i < agentChannels.length; i++) {
    const channelId = agentChannels[i]!;
    const requireMention = i > 0; // first channel = home, always responsive
    const botUserIds: string[] = [];
    for (const other of agents.list) {
      if (other.id === agentId) continue;
      const otherChannels = other.slack.channels ?? [];
      if (!otherChannels.includes(channelId)) continue;
      if (!other.slack.bot_user_id) {
        process.stderr.write(
          `[fleetmind renderer] WARNING: agent "${other.id}" shares channel ${channelId} with "${agentId}" but has no bot_user_id — skipping bot-specific users allowlist entry for that agent.\n`
        );
        continue;
      }
      botUserIds.push(other.slack.bot_user_id);
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
  const agentPlugins = agent.plugins ?? defaults.plugins;
  const pluginEntries: Record<string, unknown> = {};
  for (const plugin of [...agentPlugins].sort()) {
    pluginEntries[plugin] = { enabled: true };
  }

  return {
    agents: {
      defaults: { model: { primary: defaults.model } },
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
 * "one gateway, N agents" topology — it does NOT match the gg-sandbox deploy
 * (one gateway per agent EC2). Kept for backward compatibility only.
 */
export function renderOpenClawJson(fleet: Fleet): Record<string, unknown> {
  const { agents, openclaw } = fleet;
  const defaults = agents.defaults;
  const oc = openclaw;

  // Agent list
  const agentList = agents.list.map((agent) => {
    const model = agent.model ?? defaults.model;
    const workspace = `${defaults.workspace_base}/${agent.id}`;
    const agentDir = `${defaults.workspace_base}/agents/${agent.id}/agent`;
    return {
      id: agent.id,
      name: agent.name,
      workspace,
      agentDir,
      model: { primary: model },
      ...(agent.orchestrator ? { default: true } : {}),
    };
  });

  // Bindings: one per agent, matched on Slack accountId
  const bindings = agents.list.map((agent) => ({
    agentId: agent.id,
    match: {
      channel: "slack",
      accountId: agent.slack.account_id,
    },
  }));

  // Slack accounts (no per-account groupPolicy; lives at top level as "allowlist")
  const slackAccounts: Record<string, unknown> = {};
  for (const agent of agents.list) {
    slackAccounts[agent.slack.account_id] = {
      enabled: true,
      botToken: agent.slack.bot_token,
      appToken: agent.slack.app_token,
      webhookPath: `/slack/${agent.slack.account_id}`,
    };
  }

  // agentToAgent allow list — array of target agent-id strings (per OpenClaw config schema).
  // Deduplicated and sorted for stable output.
  const a2aAllowSet = new Set<string>();
  for (const agent of agents.list) {
    for (const targetId of agent.agent_to_agent.can_send_to) {
      a2aAllowSet.add(targetId);
    }
  }
  const a2aAllow = [...a2aAllowSet].sort();

  // Collect all plugins across agents
  const allPlugins = new Set<string>();
  for (const agent of agents.list) {
    const plugins = agent.plugins ?? defaults.plugins;
    for (const p of plugins) allPlugins.add(p);
  }
  const pluginEntries: Record<string, unknown> = {};
  for (const plugin of [...allPlugins].sort()) {
    pluginEntries[plugin] = { enabled: true };
  }

  return {
    agents: {
      defaults: { model: { primary: defaults.model } },
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
      entries: pluginEntries,
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: true,
    },
  };
}

export function renderTerraformVars(fleet: Fleet): string {
  const agentNames = fleet.agents.list.map((a) => `"${a.id}"`).join(", ");

  // Derive wake_target_session_key from the PM (orchestrator) agent's first
  // Slack channel. This is the channel the EventBridge wake target SSM-invokes
  // when a terminal task event fires. Empty string when the orchestrator has
  // no channels configured yet (e.g., first render before Slack apps exist) —
  // the task-ledger module gates the event target on this being non-empty.
  const pmAgent = fleet.agents.list.find((a) => a.orchestrator);
  const pmChannels = pmAgent?.slack.channels ?? [];
  const wakeKey =
    pmAgent && pmChannels.length > 0
      ? `agent:main:slack:channel:${pmChannels[0]}`
      : "";

  // Derive agent_orchestrators map from fleet.yaml. Drives task-ledger's IAM
  // policy split (pm vs worker) and the wake target Name tag derivation.
  const orchestratorEntries = fleet.agents.list
    .map((a) => `  ${a.id} = ${a.orchestrator ? "true" : "false"}`)
    .join("\n");

  // Derive agent_ports: assign sequential ports starting at 18789 by index.
  // Operators can override per-agent in workspaces/*.tfvars; the derived value
  // is used when no override is present.
  const BASE_PORT = 18789;
  const agentPortEntries = fleet.agents.list
    .map((a, i) => `  ${a.id} = ${BASE_PORT + i}`)
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
    `# Per-agent gateway ports (sequential from ${BASE_PORT}). Override in workspaces/*.tfvars`,
    `# if you need specific ports.`,
    `agent_ports = {`,
    agentPortEntries,
    `}`,
    ``,
    `# Wake target derived from the PM agent's first Slack channel. Used by the`,
    `# task-ledger EventBridge target to SSM-invoke the PM on terminal task events.`,
    `# Empty until the PM's slack.channels is populated in fleet.yaml.`,
    `wake_target_session_key = "${wakeKey}"`,
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
    fs.mkdirSync(path.dirname(agentOcPath), { recursive: true });
    fs.writeFileSync(
      agentOcPath,
      JSON.stringify(renderAgentOpenClawJson(fleet, agent.id), null, 2)
    );
    agentPaths[agent.id] = agentOcPath;
    written[`openclaw_json:${agent.id}`] = agentOcPath;
  }

  // terraform vars
  // Auto-derive tfvars path from fleet name when the operator hasn't set
  // outputs.terraform_vars explicitly (i.e. it still has the schema default).
  // Result: ./workspaces/<fleet-name>.derived.tfvars
  const DEFAULT_TF_VARS = "./rendered/fleet.derived.tfvars";
  const resolvedTfVars =
    fleet.outputs.terraform_vars === DEFAULT_TF_VARS
      ? `./workspaces/${fleet.fleet.name}.derived.tfvars`
      : fleet.outputs.terraform_vars;
  const tfPath = path.resolve(baseDir, resolvedTfVars);

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

  // Roster: other agents with only routing-safe fields
  const roster = fleet.agents.list
    .filter((a) => a.id !== agentId)
    .map((a) => ({
      id: a.id,
      name: a.name,
      emoji: a.emoji,
      role: a.role,
      orchestrator: a.orchestrator ?? false,
      ...(a.slack?.channels ? { channels: a.slack.channels } : {}),
    }));

  const slice = {
    fleet: {
      name: fleet.fleet.name,
      version: fleet.fleet.version,
    },
    ...(fleet.delegation ? { delegation: fleet.delegation } : {}),
    ...(fleet.context ? { context: fleet.context } : {}),
    agents: {
      defaults: {
        model: fleet.agents.defaults.model,
        workspace_base: fleet.agents.defaults.workspace_base,
      },
      self: {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        role: agent.role,
        orchestrator: agent.orchestrator ?? false,
        model: agent.model ?? fleet.agents.defaults.model,
        skills: agent.skills ?? [],
        ...(agent.delegation ? { delegation: agent.delegation } : {}),
      },
      roster,
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
