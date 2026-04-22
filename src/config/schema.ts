/**
 * FleetMind config schema — validated with Zod.
 * Mirrors fleet.yaml structure exactly.
 */

import { z } from "zod";

export const SkillRefSchema = z.union([
  z.string().transform((s) => ({ name: s, version: undefined })),
  z.object({
    name: z.string(),
    version: z.string().optional(),
  }),
]);

export const SlackAccountSchema = z.object({
  account_id: z.string(),
  bot_token: z.string(),
  app_token: z.string(),
});

export const AgentToAgentSchema = z.object({
  can_send_to: z.array(z.string()).default([]),
});

export const PersonaSchema = z.object({
  soul: z.string().default("You are a helpful assistant."),
});

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().default("🤖"),
  description: z.string().default(""),
  orchestrator: z.boolean().default(false),
  model: z.string().optional(),
  persona: PersonaSchema.default({}),
  slack: SlackAccountSchema,
  skills: z.array(SkillRefSchema).default([]),
  plugins: z.array(z.string()).optional(),
  agent_to_agent: AgentToAgentSchema.default({}),
});

export const AgentDefaultsSchema = z.object({
  model: z.string().default("anthropic/claude-sonnet-4-6"),
  workspace_base: z.string().default("/home/ec2-user/.openclaw"),
  plugins: z.array(z.string()).default(["anthropic"]),
});

export const AgentsConfigSchema = z.object({
  defaults: AgentDefaultsSchema.default({}),
  list: z.array(AgentSchema),
});

export const SkillsRepoSchema = z.object({
  url: z.string().default(""),
  branch: z.string().default("main"),
  tag: z.string().optional(),
  poll_interval: z.string().default("60s"),
  local: z.string().optional(),
});

export const SecretsSchema = z.object({
  provider: z.enum(["env", "aws-ssm", "vault"]).default("env"),
});

export const OutputsSchema = z.object({
  openclaw_json: z.string().default("./rendered/openclaw.json"),
  terraform_vars: z.string().default("./rendered/fleet.auto.tfvars"),
  workspace_manifests: z.string().default("./rendered/workspaces/"),
});

export const GatewayConfigSchema = z.object({
  port: z.number().default(18789),
  mode: z.string().default("local"),
  bind: z.string().default("loopback"),
});

export const OpenClawConfigSchema = z.object({
  gateway: GatewayConfigSchema.default({}),
  session: z.object({ dm_scope: z.string().default("per-channel-peer") }).default({}),
  tools: z.object({
    profile: z.string().default("coding"),
    web_search: z.object({
      enabled: z.boolean().default(true),
      provider: z.string().default("brave"),
    }).default({}),
  }).default({}),
  slack: z.object({
    mode: z.string().default("socket"),
    typing_reaction: z.string().default("thinking_face"),
    ack_reaction: z.string().default("eyes"),
    allow_bots: z.boolean().default(true),
    history_limit: z.number().default(111),
    streaming: z.object({
      mode: z.string().default("partial"),
      native_transport: z.boolean().default(true),
    }).default({}),
    reply_to_mode_by_chat_type: z.object({
      channel: z.string().default("all"),
    }).default({}),
  }).default({}),
});

export const FleetMetaSchema = z.object({
  name: z.string(),
  version: z.string().default("1.0.0"),
  client: z.string().default(""),
  description: z.string().default(""),
});

export const FleetSchema = z.object({
  fleet: FleetMetaSchema,
  agents: AgentsConfigSchema,
  skills_repo: SkillsRepoSchema.default({}),
  secrets: SecretsSchema.default({}),
  outputs: OutputsSchema.default({}),
  openclaw: OpenClawConfigSchema.default({}),
});

// Inferred types
export type SkillRef = { name: string; version?: string };
export type SlackAccount = z.infer<typeof SlackAccountSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type SkillsRepo = z.infer<typeof SkillsRepoSchema>;
export type FleetFile = z.infer<typeof FleetSchema>;

/** Resolved fleet with helper accessors */
export interface Fleet extends FleetFile {
  getAgent(id: string): AgentConfig | undefined;
  orchestrator: AgentConfig | undefined;
  specialists: AgentConfig[];
}
