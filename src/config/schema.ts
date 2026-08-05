/**
 * FleetMind config schema — validated with Zod.
 * Mirrors fleet.yaml structure exactly (the "wire" layer).
 *
 * Security-sensitive identifiers (fleet name, agent/target ids, skill names,
 * NATS subject prefix) are branded + validated here via the schemas in
 * ../core/identifiers.ts, so anything that survives parsing is already safe
 * to interpolate into paths, shell commands, S3 keys, systemd units, env var
 * names, and NATS subjects. Cross-references (an agent's `target`, channel
 * resolution) are resolved in ../core/model.ts after parse. Per-agent
 * workspace paths are NOT operator-configurable — every target uses the
 * fixed standard OpenClaw HOME contract (see ../core/model.ts's
 * `standardWorkspaceBase`), so there is no `workspace_base` field here.
 */

import { z } from "zod";
import {
  FleetNameSchema,
  AgentIdSchema,
  TargetIdSchema,
  SkillNameSchema,
  NatsSubjectPrefixSchema,
} from "../core/identifiers.js";
import { AWS_RUNTIME_USER_PATTERN, DEFAULT_AWS_RUNTIME_USER } from "../deploy/aws-runtime-user.js";

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

/** A named non-default GitHub App. `project` is reserved for the legacy default App. */
export const GitHubAppAliasSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "GitHub App aliases must be lowercase kebab-case")
  .refine((alias) => alias !== "project", "'project' is the reserved default GitHub App alias");
export type GitHubAppAlias = z.infer<typeof GitHubAppAliasSchema>;

export const SkillRefSchema = z.union([
  // shorthand string → defaults to client source
  z.string().transform((s) => ({
    name: SkillNameSchema.parse(s),
    source: "client" as const,
    author: undefined,
    version: undefined,
  })),
  z.object({
    name: SkillNameSchema,
    /** Skill source tier. Defaults to "client". */
    source: SkillSourceSchema,
    /** ClaWHub author handle — required when source is "clawhub". */
    author: z.string().optional(),
    version: z.string().optional(),
  }),
]);

// ── Channels (discriminated union on `provider`) ─────────────────────────────
// A human-interaction channel for an agent. Slack is the first provider; future
// providers (Teams, Discord, email, web) add new variants to ChannelSchema.

export const SlackChannelSchema = z.object({
  provider: z.literal("slack"),
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
export type SlackChannel = z.infer<typeof SlackChannelSchema>;

export const ChannelSchema = z.discriminatedUnion("provider", [SlackChannelSchema]);
export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelProvider = Channel["provider"];

export const AgentToAgentSchema = z.object({
  can_send_to: z.array(z.string()).default([]),
});

export const PersonaSchema = z.object({
  soul: z.string().default("You are a helpful assistant."),
});

// ── Delegation config ────────────────────────────────────────────────────────

// ── NATS config ────────────────────────────────────────────────────────────

/**
 * NATS connection config embedded in fleet delegation settings.
 * Used by both the PM bot publisher and the worker subscriber.
 */
export const NatsConfigSchema = z.object({
  /**
   * NATS server URLs. One or more servers for redundancy.
   * Optional — if omitted, the renderer derives the URL from the fleet name
   * using the Cloud Map convention: nats://nats.<fleet_name>.internal:4222
   * Example: ["nats://nats.myfleet.internal:4222"]
   */
  servers: z.array(z.string()).min(1).optional(),
  /**
   * Optional credentials file path (nkeys/creds format).
   * If omitted the connection is unauthenticated.
   */
  creds_file: z.string().optional(),
  /** Inbox prefix used for request-reply if needed; defaults to "_INBOX". */
  inbox_prefix: z.string().default("_INBOX"),
  /** Subject prefix for all fleetmind task events. Default: "fleetmind". */
  subject_prefix: NatsSubjectPrefixSchema.default("fleetmind"),
  /** Connect timeout in milliseconds. Default 5000. */
  connect_timeout_ms: z.number().int().positive().default(5000),
  /** Max reconnect attempts (-1 = unlimited). Default -1. */
  max_reconnect: z.number().int().default(-1),
});
export type NatsConfig = z.infer<typeof NatsConfigSchema>;

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
  /**
   * NATS connection config. Required when delegation.enabled = true.
   */
  nats: NatsConfigSchema.optional(),
}).superRefine((val, ctx) => {
  if (val.enabled) {
    if (!val.table_name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delegation.table_name is required when delegation.enabled = true" });
    }
    if (!val.s3_bucket) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delegation.s3_bucket is required when delegation.enabled = true" });
    }
    // Note: delegation.nats is required to publish task events, but not for
    // read-only commands (narrative get, query). Validated at publish time
    // in the CLI commands rather than at schema parse time so that minimal
    // fleet configs built from a name (no fleet.yaml) still work for queries.
  }
});

/** Per-agent delegation settings. */
export const DelegationAgentSchema = z.object({
  /** Agent IDs this agent can delegate to (PM bots). */
  worker_bots: z.array(z.string()).optional(),
  /** Specialty label used by PM bots for routing decisions (worker bots). */
  specialty: z.string().optional(),
});

/**
 * Optional per-agent API keys, keyed by model provider.
 *
 * FleetMind is provider-neutral: an agent's `model` is a "provider/model"
 * string, and OpenClaw makes the actual call. This map lets an operator point a
 * provider at a specific credential when the conventional env var isn't enough.
 * Each value may be a ${VAR} placeholder or a literal.
 *
 * Resolution order for `fleetmind secrets populate` (per provider P used by the
 * agent, derived from its model string):
 *   1. ${<AGENT_ID_UPPER>_<P_UPPER>_API_KEY} env var
 *   2. This map's `P` entry (resolved from env if it's a placeholder)
 *   3. Fleet-wide ${<P_UPPER>_API_KEY} env var
 *
 * Example:
 *   api_keys:
 *     anthropic: ${ANTHROPIC_API_KEY}
 *     openai: ${ACME_OPENAI_KEY}
 */
export const ApiKeysSchema = z.record(z.string(), z.string());
export type ApiKeys = z.infer<typeof ApiKeysSchema>;

export const AgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  emoji: z.string().default("🤖"),
  description: z.string().default(""),
  orchestrator: z.boolean().default(false),
  role: AgentRoleSchema.default("worker"),
  model: z.string().optional(),
  /** Ordered fallback models ("provider/model") OpenClaw tries when this agent's
   *  primary model fails. Overrides agents.defaults.fallback_models. An empty
   *  list makes the agent strict (no fallback). */
  fallback_models: z.array(z.string()).optional(),
  persona: PersonaSchema.default({}),
  /** Runtime host this agent is deployed to — references a key in `targets`.
   *  Optional here; falls back to `agents.defaults.target`. Normalization
   *  fails if neither is set or the reference is dangling. */
  target: TargetIdSchema.optional(),
  /** Human-interaction channels for this agent (Slack, …). Per-agent fleet.yaml
   *  slices pushed to hosts omit channel credentials for security, so this may
   *  be empty on the bot side. */
  channels: z.array(ChannelSchema).default([]),
  /** Optional per-agent API keys, keyed by model provider (anthropic, openai, …). */
  api_keys: ApiKeysSchema.optional(),
  /** REQUIRED — lowercase model-provider tokens this agent needs API keys for
   *  (e.g. ["anthropic"] or ["anthropic", "openai"]). Drives per-provider
   *  Secrets Manager naming. Explicit declaration only; no inference. */
  providers: z.array(z.string()).optional(),
  skills: z.array(SkillRefSchema).default([]),
  plugins: z.array(z.string()).optional(),
  agent_to_agent: AgentToAgentSchema.default({}),
  /** Optional per-agent delegation config. */
  delegation: DelegationAgentSchema.optional(),
  /** Whether this agent requires its own GitHub App for repo access. Defaults
   *  to true: every agent gets a GitHub App unless explicitly opted out with
   *  `github_access: false`. Set false for agents that never touch code
   *  (e.g. a pure-chat triage bot) to skip GitHub App creation for them. The
   *  permission set still comes from the bot-type defaults (or the `github_app`
   *  override below) when access is required. */
  github_access: z.boolean().default(true),
  /** Optional per-agent GitHub App configuration. Permissions + events
   *  declared here override the bot-type defaults from
   *  openclaw/<bot-type>/github-app-permissions.yaml. Permissions are merged
   *  key-by-key: the per-agent entry wins where it sets a key, and the
   *  per-bot-type entry fills in the rest. Events are taken from per-agent
   *  when present, else fall back to per-bot-type. Only consulted when
   *  `github_access` is true (the default). */
  github_app: GitHubAppConfigSchema.optional(),
  /** Additional GitHub Apps this agent may use. Credentials are isolated under
   * `github-apps/<alias>/`; `project` remains the implicit default App. */
  github_app_aliases: z.array(GitHubAppAliasSchema).default([]),
});

/**
 * Per-agent or per-model prompt-caching retention policy.
 * Maps directly to OpenClaw's `agents.defaults.params.cacheRetention`.
 *
 * - "none"  — caching disabled
 * - "short" — 5-minute ephemeral cache (Anthropic default)
 * - "long"  — 1-hour cache TTL (Anthropic direct / Vertex only)
 */
export const CacheRetentionSchema = z.enum(["none", "short", "long"]);
export type CacheRetention = z.infer<typeof CacheRetentionSchema>;

/** OpenClaw agent params that flow through to agents.defaults.params. */
export const AgentParamsSchema = z.object({
  /** Prompt-cache retention policy for this agent. */
  cacheRetention: CacheRetentionSchema.optional(),
});
export type AgentParams = z.infer<typeof AgentParamsSchema>;

/** Per-model param overrides (keyed by "provider/model" string). */
export const AgentModelOverridesSchema = z.record(
  z.string(),
  z.object({ params: AgentParamsSchema.optional() })
);
export type AgentModelOverrides = z.infer<typeof AgentModelOverridesSchema>;

export const AgentDefaultsSchema = z.object({
  model: z.string().default("anthropic/claude-sonnet-4-6"),
  /** Fleet-wide ordered fallback models ("provider/model") materialized into
   *  every agent's model config unless the agent sets its own fallback_models. */
  fallback_models: z.array(z.string()).optional(),
  /** Default runtime target for agents that don't set their own `target`. */
  target: TargetIdSchema.optional(),
  plugins: z.array(z.string()).default(["anthropic"]),
  /** Global default params applied to all agents (unless overridden). */
  params: AgentParamsSchema.optional(),
  /** Per-model param overrides (keyed by "provider/model" string). */
  models: AgentModelOverridesSchema.optional(),
  /**
   * Maximum seconds OpenClaw will wait for a single LLM call to complete
   * before aborting and surfacing a timeout. Maps to OpenClaw's
   * `agents.defaults.timeoutSeconds`. OpenClaw's built-in default is ~60s,
   * which is too tight for the typical delegated-bot turn (Slack post +
   * external tool calls like `gh` + write the actual artifact + back to
   * Slack often exceeds 60s on Sonnet). We default to 300s so first-turn
   * exploratory work completes; bump higher for heavier work.
   *
   * Symptom when this is too low: agent turn fails with
   * "Request timed out before a response was generated. Please try again,
   * or increase `agents.defaults.timeoutSeconds` in your config." and the
   * worker never opens its Slack thread / publishes its ship event.
   */
  timeout_seconds: z.number().int().positive().default(300),
});

export const AgentsConfigSchema = z.object({
  defaults: AgentDefaultsSchema.default({}),
  list: z.array(AgentSchema),
});

// ── Targets (runtime hosts) ──────────────────────────────────────────────────
// Where an agent runs, how to reach it, and how to manage its service. The
// provider-specific block (aws / ssh) is discriminated on `provider`.

const TargetCommonSchema = {
  /** Host operating system — selects path conventions and defaults. */
  os: z.enum(["linux", "macos"]).default("linux"),
  /** Service supervisor used to (re)start the gateway on this host. */
  service_manager: z.enum(["systemd", "launchd", "none"]).default("systemd"),
};

export const AwsSsmTargetSchema = z.object({
  provider: z.literal("aws-ssm"),
  ...TargetCommonSchema,
  aws: z.object({
    region: z.string(),
    /** Linux account that owns the OpenClaw user-systemd services on this
     * target. Set `ec2-user` for existing pre-user-systemd hosts during a
     * migration; new FleetMind AWS hosts use `openclaw`. */
    runtime_user: z.string()
      .regex(AWS_RUNTIME_USER_PATTERN, "must be a safe Linux username")
      .default(DEFAULT_AWS_RUNTIME_USER),
  }),
}).strict();

export const SshTargetSchema = z.object({
  provider: z.literal("ssh"),
  ...TargetCommonSchema,
  ssh: z.object({
    host: z.string(),
    user: z.string(),
    port: z.number().int().positive().default(22),
    /** Path to a private key for auth. Falls back to the SSH agent when unset. */
    identity_file: z.string().optional(),
  }),
}).strict();

export const LocalTargetSchema = z.object({
  provider: z.literal("local"),
  ...TargetCommonSchema,
}).strict();

export const TargetSchema = z.discriminatedUnion("provider", [
  AwsSsmTargetSchema,
  SshTargetSchema,
  LocalTargetSchema,
]);
export type TargetConfig = z.infer<typeof TargetSchema>;
export type TargetProvider = TargetConfig["provider"];

/** Map of target id → target config. */
export const TargetsSchema = z.record(z.string(), TargetSchema).default({});

// ── Deploy (artifact transport) ──────────────────────────────────────────────
// Where rendered agent bundles are published before a target applies them.
// Optional: when omitted, deploy machinery falls back to the legacy
// `<fleet-name>-ledger` S3 bucket convention.

export const ArtifactStoreSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("s3"),
    s3: z.object({
      bucket: z.string(),
      region: z.string().optional(),
    }),
  }),
  z.object({
    provider: z.literal("local-fs"),
    local_fs: z.object({
      path: z.string(),
    }),
  }),
  z.object({
    provider: z.literal("scp"),
    scp: z.object({
      host: z.string(),
      user: z.string(),
      path: z.string(),
    }),
  }),
]);
export type ArtifactStoreConfig = z.infer<typeof ArtifactStoreSchema>;

export const DeploySchema = z.object({
  artifact_store: ArtifactStoreSchema,
});
export type DeployConfig = z.infer<typeof DeploySchema>;

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

/**
 * OpenClaw hooks (webhook endpoint) config.
 * `token` is NOT represented here — it is always rendered as the
 * `${<AGENT_UPPER>_HOOKS_TOKEN}` env-var placeholder by the renderer so
 * the actual secret never appears in fleet.yaml or in version control.
 */
export const OpenClawHooksSchema = z.object({
  /** Enable the HTTP hooks endpoint. */
  enabled: z.boolean().default(true),
  /** URL path prefix for all hook endpoints (e.g. "/hooks"). */
  path: z.string().default("/hooks"),
  /**
   * Agent IDs that hook requests may target via /hooks/agent.
   * Defaults to ["main"] — enough for wakeAgent() calls from the NATS
   * subscriber. Operators can extend this list as needed.
   */
  allowed_agent_ids: z.array(z.string()).default(["main"]),
}).default({});

export type OpenClawHooksConfig = z.infer<typeof OpenClawHooksSchema>;

export const GatewayConfigSchema = z.object({
  port: z.number().default(18789),
  mode: z.string().default("local"),
  bind: z.string().default("loopback"),
});

export const OpenClawConfigSchema = z.object({
  gateway: GatewayConfigSchema.default({}),
  hooks: OpenClawHooksSchema,
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
  name: FleetNameSchema,
  version: z.string().default("1.0.0"),
  client: z.string().default(""),
  description: z.string().default(""),
});

export const FleetSchema = z.object({
  fleet: FleetMetaSchema,
  delegation: DelegationFleetSchema.optional(),
  /** Runtime hosts, keyed by id. Agents reference these via `target`. */
  targets: TargetsSchema,
  /** Artifact transport for deploys. Optional (legacy bucket convention). */
  deploy: DeploySchema.optional(),
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
export type SkillRef = z.infer<typeof SkillRefSchema>;
export type ApiKeysConfig = z.infer<typeof ApiKeysSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type SkillsRepo = z.infer<typeof SkillsRepoSchema>;
export type PrivateRegistry = z.infer<typeof PrivateRegistrySchema>;
export type FleetFile = z.infer<typeof FleetSchema>;

/** Normalized fleet model (with resolved targets + accessors). Re-exported here
 *  for back-compat; defined in ../core/model.ts. */
export type { Fleet, FleetModel } from "../core/model.js";
