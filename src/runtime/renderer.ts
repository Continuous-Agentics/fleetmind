/**
 * FleetMind renderer — generates openclaw.json and terraform vars from fleet config.
 */

import fs from "node:fs";
import path from "node:path";
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

  // Slack accounts — only this agent's account
  const slackAccounts: Record<string, unknown> = {
    [agent.slack.account_id]: {
      enabled: true,
      botToken: agent.slack.bot_token,
      appToken: agent.slack.app_token,
      webhookPath: `/slack/${agent.slack.account_id}`,
      groupPolicy: "open",
    },
  };

  // agentToAgent allow list — only entries where this agent is the sender
  const a2aAllow: Array<{ from: string; to: string }> = [];
  for (const targetId of agent.agent_to_agent.can_send_to) {
    a2aAllow.push({ from: agent.id, to: targetId });
  }

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
    channels: {
      slack: {
        mode: oc.slack.mode,
        enabled: true,
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

  // Slack accounts
  const slackAccounts: Record<string, unknown> = {};
  for (const agent of agents.list) {
    slackAccounts[agent.slack.account_id] = {
      enabled: true,
      botToken: agent.slack.bot_token,
      appToken: agent.slack.app_token,
      webhookPath: `/slack/${agent.slack.account_id}`,
      groupPolicy: "open",
    };
  }

  // agentToAgent allow list (deduplicated)
  const a2aAllow: Array<{ from: string; to: string }> = [];
  for (const agent of agents.list) {
    for (const targetId of agent.agent_to_agent.can_send_to) {
      if (!a2aAllow.some((e) => e.from === agent.id && e.to === targetId)) {
        a2aAllow.push({ from: agent.id, to: targetId });
      }
    }
  }

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
    channels: {
      slack: {
        mode: oc.slack.mode,
        enabled: true,
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
  const agentModelEntries = fleet.agents.list
    .map((a) => {
      const model = a.model ?? fleet.agents.defaults.model;
      return `  ${a.id} = "${model}"`;
    })
    .join("\n");

  const lines = [
    `# Auto-generated by FleetMind — do not edit manually`,
    `# Fleet: ${fleet.fleet.name} v${fleet.fleet.version}`,
    ``,
    `fleet_name  = "${fleet.fleet.name}"`,
    `agent_names = [${agentNames}]`,
    ``,
    `# Per-agent model assignments (informational — model is set in openclaw.json workspace config)`,
    `agent_models = {`,
    agentModelEntries,
    `}`,
    ``,
    `# NOTE: agent_ports, instance_type, aws_region, and other infrastructure vars`,
    `# are not derived from fleet.yaml — set them in terraform.tfvars manually.`,
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
function resolveOpenClawBaseDir(ocJsonPath: string, baseDir: string): string {
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
  const tfPath = path.resolve(baseDir, fleet.outputs.terraform_vars);
  fs.mkdirSync(path.dirname(tfPath), { recursive: true });
  fs.writeFileSync(tfPath, renderTerraformVars(fleet));
  written["terraform_vars"] = tfPath;

  return written;
}
