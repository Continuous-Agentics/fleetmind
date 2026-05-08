/**
 * FleetMind config schema — validated with Zod.
 * Mirrors fleet.yaml structure exactly.
 */

import { z } from "zod";

/** Where a skill comes from:
 *  - clawhub: public skill published on ClaWHub (e.g. by continuous-agentics)
 *  - private: Continuous Agentics proprietary skill library (requires CA_REGISTRY_TOKEN)
 *  - client:  skill in the client's own skills_repo (default)
 */
export const SkillSourceSchema = z.enum(["clawhub", "private", "client"]).default("client");

export const SkillRefSchema = z.union([
  // shorthand string → defaults to client source
  z.string().transform((s) => ({
    name: s,
    source: "client" as const,
    author: undefined,
    version: undefined,
  })),
  z.object({
    name: z.string(),
    /** Skill source tier. Defaults to "client". */
    source: SkillSourceSchema,
    /** ClaWHub author handle — required when source is "clawhub". */
    author: z.string().optional(),
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

// ── Delegation config ────────────────────────────────────────────────────────

/** Per-fleet delegation settings. Optional — fleets without delegation work normally. */
export const DelegationFleetSchema = z.object({
  enabled: z.boolean().default(false),
  /** DynamoDB table name for task state. Required when enabled. */
  table_name: z.string().optional(),
  /** S3 bucket name for narrative content. Required when enabled. */
  s3_bucket: z.string().optional(),
  /**
   * S3 key template for task narratives.
   * Tokens: {project}, {date}, {task_id}
   * Default: "v0/projects/{project}/tasks/{date}-{task_id}.md"
   */
  s3_key_template: z.string().default("v0/projects/{project}/tasks/{date}-{task_id}.md"),
  aws_region: z.string().optional(),
}).superRefine((val, ctx) => {
  if (val.enabled) {
    if (!val.table_name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delegation.table_name is required when delegation.enabled = true" });
    }
    if (!val.s3_bucket) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delegation.s3_bucket is required when delegation.enabled = true" });
    }
  }
});

/** Per-agent delegation settings. */
export const DelegationAgentSchema = z.object({
  /** Agent IDs this agent can delegate to (PM bots). */
  worker_bots: z.array(z.string()).optional(),
  /** Specialty label used by PM bots for routing decisions (worker bots). */
  specialty: z.string().optional(),
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
  /** Optional per-agent delegation config. */
  delegation: DelegationAgentSchema.optional(),
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

/** Private CA registry config — used for source: private skills */
export const PrivateRegistrySchema = z.object({
  /** npm registry URL, e.g. https://npm.pkg.github.com */
  url: z.string().default("https://npm.pkg.github.com"),
  /** Env var name holding the registry auth token. Defaults to CA_REGISTRY_TOKEN */
  token_env: z.string().default("CA_REGISTRY_TOKEN"),
  /** npm scope for CA private packages, e.g. @continuous-agentics */
  scope: z.string().default("@continuous-agentics"),
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

export const ContextSchema = z.object({
  provider: z.enum(["dynamodb", "local"]).default("local"),
  table: z.string().optional(),
  region: z.string().optional(),
  ttl_days: z.number().optional(),
});

export const FleetMetaSchema = z.object({
  name: z.string(),
  version: z.string().default("1.0.0"),
  client: z.string().default(""),
  description: z.string().default(""),
});

export const FleetSchema = z.object({
  fleet: FleetMetaSchema,
  delegation: DelegationFleetSchema.optional(),
  agents: AgentsConfigSchema,
  skills_repo: SkillsRepoSchema.default({}),
  /** Optional: config for Continuous Agentics private skill registry */
  private_registry: PrivateRegistrySchema.default({}),
  secrets: SecretsSchema.default({}),
  outputs: OutputsSchema.default({}),
  openclaw: OpenClawConfigSchema.default({}),
  context: ContextSchema.default({}),
});

// Inferred types
export type DelegationFleetConfig = z.infer<typeof DelegationFleetSchema>;
export type DelegationAgentConfig = z.infer<typeof DelegationAgentSchema>;
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type SkillRef = { name: string; source: SkillSource; author?: string; version?: string };
export type SlackAccount = z.infer<typeof SlackAccountSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type SkillsRepo = z.infer<typeof SkillsRepoSchema>;
export type PrivateRegistry = z.infer<typeof PrivateRegistrySchema>;
export type FleetFile = z.infer<typeof FleetSchema>;

/** Resolved fleet with helper accessors */
export interface Fleet extends FleetFile {
  getAgent(id: string): AgentConfig | undefined;
  orchestrator: AgentConfig | undefined;
  specialists: AgentConfig[];
}
