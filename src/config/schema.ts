/**
 * FleetMind config schema — validated with Zod.
 * Mirrors fleet.yaml structure exactly.
 */

import { z } from "zod";

/** Where a skill comes from:
 *  - clawhub:   public skill published on ClaWHub (e.g. by continuous-agentics)
 *  - private:   Continuous Agentics proprietary skill library (requires CA_REGISTRY_TOKEN)
 *  - client:    skill in the client's own skills_repo (default)
 *  - fleetmind: bundled first-party skill shipped with the fleetmind package
 *               (e.g. bot-delegation, bot-reception). Resolves relative to the
 *               fleetmind package root at openclaw/skills/<name>/, regardless of
 *               where the operator's fleet.yaml or skills_repo lives.
 */
export const SkillSourceSchema = z.enum(["clawhub", "private", "client", "fleetmind"]).default("client");

/** Agent role enum — also indexes the openclaw/<role>-bot/ directory. */
export const AgentRoleSchema = z.enum(["pm", "backend-worker", "frontend-worker", "worker"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** GitHub App permission level. 'none' means explicitly omit the scope. */
export const GitHubAppPermissionLevelSchema = z.enum(["read", "write", "admin", "none"]);
export type GitHubAppPermissionLevel = z.infer<typeof GitHubAppPermissionLevelSchema>;

/** Per-agent (or per-bot-type) GitHub App config. Permissions map to GitHub's
 *  documented scope names (contents, pull_requests, issues, actions, checks,
 *  metadata, administration, deployments, packages, pages, security_events, etc.).
 *  Events are GitHub webhook event names; defaults to empty (no webhook events). */
export const GitHubAppConfigSchema = z.object({
  permissions: z.record(z.string(), GitHubAppPermissionLevelSchema).default({}),
  events: z.array(z.string()).default([]),
});
export type GitHubAppConfig = z.infer<typeof GitHubAppConfigSchema>;

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
  /** Slack bot user_id (U…) for this agent — captured via `auth.test`. Used by the
   * renderer to build per-channel `users` allowlists for inter-bot delivery.
   * Optional: if unset the renderer emits a warning but does not fail. */
  bot_user_id: z.string().optional(),
  /** Slack channel IDs (C…) this agent operates in. The renderer uses this list
   * to emit `channels.slack.channels.<id>` entries with inter-bot users allowlists. */
  channels: z.array(z.string()).default([]),
  // ── Slack App manifest generation (`fleetmind slack manifests`) ──────────
  /** Long-form description for the Slack App manifest. Auto-generated from
   * agent description + role + fleet name when omitted. */
  long_description: z.string().optional(),
  /** Hex colour for the Slack App display info (e.g. "#8B4513").
   * Defaults per agent role when omitted. Override here for per-agent control. */
  background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  /** Extra bot OAuth scopes appended after the default set (deduped). */
  extra_scopes: z.array(z.string()).default([]),
  /** Extra Slack event subscriptions appended after the default set (deduped). */
  extra_events: z.array(z.string()).default([]),
});

export const AgentToAgentSchema = z.object({
  can_send_to: z.array(z.string()).default([]),
});

export const PersonaSchema = z.object({
  soul: z.string().default("You are a helpful assistant."),
});

// ── Delegation config ────────────────────────────────────────────────────────

/**
 * A recurring sweep job seeded into the PM bot's OpenClaw cron scheduler.
 *
 * Each sweep fires an isolated agent turn with `WORKER_SWEEP: <worker_id>`
 * so the PM bot can poll a given worker's in-flight tasks and close the loop
 * on terminal updates. Sweeps are seeded idempotently into
 * `~/.openclaw/cron/jobs.json` by `fleetmind deploy` — no AWS infrastructure
 * required. Jobs survive gateway restarts (persisted in jobs.json).
 *
 * Specify either `every` (e.g. "5m") or `cron_expr` (5-field cron). Not both.
 */
export const CronSweepSchema = z.object({
  /** Unique job name within the fleet (used for idempotent seeding). */
  name: z.string(),
  /** Agent ID of the worker bot this sweep targets. */
  worker_id: z.string(),
  /** Fixed interval (e.g. "5m", "10m"). Mutually exclusive with cron_expr. */
  every: z.string().optional(),
  /** 5-field cron expression (e.g. `*\/5 * * * *`). Mutually exclusive with every. */
  cron_expr: z.string().optional(),
  /** IANA timezone for cron_expr interpretation (e.g. "America/Los_Angeles"). */
  tz: z.string().optional(),
  /**
   * Model override for the isolated sweep turn.
   * Defaults to "haiku" — cost-optimised, same tier as SOD/EOD heartbeat jobs.
   */
  model: z.string().default("haiku"),
  /** Human-readable description surfaced in `openclaw cron list`. */
  description: z.string().optional(),
}).refine(
  (s) => !!(s.every ?? s.cron_expr),
  { message: "Each sweep must specify either 'every' or 'cron_expr'" }
);

export type CronSweepConfig = z.infer<typeof CronSweepSchema>;

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
  /**
   * Recurring sweep jobs for this PM bot.
   *
   * Each sweep is seeded into `~/.openclaw/cron/jobs.json` by `fleetmind deploy`
   * as an isolated agent-turn job firing `WORKER_SWEEP: <worker_id>`. Jobs are
   * seeded idempotently (checked by name); existing jobs are not overwritten.
   * Ignored on worker bots (`orchestrator: false`).
   */
  sweeps: z.array(CronSweepSchema).optional(),
});

/**
 * Optional per-agent Anthropic config.
 *
 * api_key may be a ${VAR} placeholder or a literal value.
 * Resolution order for `fleetmind secrets populate`:
 *   1. ${<AGENT_ID_UPPER>_ANTHROPIC_API_KEY} env var
 *   2. This field (resolved from env if it's a placeholder)
 *   3. Fleet-wide ${ANTHROPIC_API_KEY} env var
 */
export const AnthropicAgentSchema = z.object({
  api_key: z.string().optional(),
});

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().default("🤖"),
  description: z.string().default(""),
  orchestrator: z.boolean().default(false),
  role: AgentRoleSchema.default("worker"),
  model: z.string().optional(),
  persona: PersonaSchema.default({}),
  slack: SlackAccountSchema,
  /** Optional per-agent Anthropic configuration. */
  anthropic: AnthropicAgentSchema.optional(),
  skills: z.array(SkillRefSchema).default([]),
  plugins: z.array(z.string()).optional(),
  agent_to_agent: AgentToAgentSchema.default({}),
  /** Optional per-agent delegation config. */
  delegation: DelegationAgentSchema.optional(),
  /** Optional per-agent workspace_base override. Falls back to
   *  agents.defaults.workspace_base. Useful for bots on custom AMIs that
   *  install openclaw in a non-default path. */
  workspace_base: z.string().optional(),
  /** Optional per-agent GitHub App configuration. Permissions + events
   *  declared here override the bot-type defaults from
   *  openclaw/<bot-type>/github-app-permissions.yaml. Permissions are merged
   *  key-by-key: the per-agent entry wins where it sets a key, and the
   *  per-bot-type entry fills in the rest. Events are taken from per-agent
   *  when present, else fall back to per-bot-type. */
  github_app: GitHubAppConfigSchema.optional(),
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

// secrets.provider is currently informational — no CLI code reads this field
// at runtime. Token resolution for `fleetmind secrets populate` uses the
// env var pattern declared in fleet.yaml (e.g. BLANKET_BOT_TOKEN) regardless
// of this setting. The enum is kept for future use: when aws-ssm and vault
// providers are wired through, this field will control which secret backend
// the CLI uses. For now, leave it as "env" (the default).
export const SecretsSchema = z.object({
  provider: z.enum(["env", "aws-ssm", "vault"]).default("env"),
});

export const OutputsSchema = z.object({
  openclaw_json: z.string().default("./rendered/openclaw.json"),
  terraform_vars: z.string().default("./rendered/fleet.derived.tfvars"),
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
      provider: z.string().default("duckduckgo"),
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
export type AnthropicAgentConfig = z.infer<typeof AnthropicAgentSchema>;
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
