/**
 * Branded, validated identifier types.
 *
 * These are the config values that flow into dangerous surfaces — shell/SSM
 * commands, filesystem paths, S3 keys/buckets, systemd unit names, env var
 * names, NATS subjects, and Terraform identifiers. Raw strings are validated
 * at the config boundary and branded so the rest of the codebase can rely on
 * them being safe path segments / shell args / subject tokens.
 *
 * Validation rules are deliberately strict: they encode the intersection of
 * every downstream naming constraint, not just the loosest one.
 */

import { z } from "zod";

/** Nominal type tag — a `string` that has passed a specific validator.
 *  Uses a string-literal phantom property (never present at runtime) rather
 *  than a `unique symbol` so the brand is nameable in emitted `.d.ts` files. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Fleet name. Becomes `<name>-ledger`/`<name>-tasks` (S3/DDB) and the
 *  `nats.<name>.internal` Cloud Map DNS label, so it must satisfy both S3
 *  bucket naming and DNS label rules. */
export type FleetName = Brand<string, "FleetName">;

/** Agent id. Becomes a filesystem path segment, a systemd unit name
 *  (`openclaw-<id>`), an env var prefix (`<ID>_BOT_TOKEN`), an S3 key segment,
 *  and a NATS subject token. */
export type AgentId = Brand<string, "AgentId">;

/** Target id. The join key between an agent and its runtime host; also a
 *  filesystem/log-safe label. Same rules as an agent id. */
export type TargetId = Brand<string, "TargetId">;

/** Skill name. Flows into `clawhub install`/`npm install` shell commands and
 *  filesystem paths, so it must be shell-safe and traversal-free. */
export type SkillName = Brand<string, "SkillName">;

/** NATS subject prefix. Dot-separated subject tokens with no wildcards. */
export type NatsSubjectPrefix = Brand<string, "NatsSubjectPrefix">;

// ── Validators ───────────────────────────────────────────────────────────────
// Each returns a human-readable error message, or null when the value is valid.

function validateFleetName(v: string): string | null {
  if (v.length < 2 || v.length > 56) {
    return 'must be 2–56 characters (becomes the S3 bucket "<name>-ledger", capped at 63)';
  }
  if (!/^[a-z][a-z0-9-]*$/.test(v)) {
    return "must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (S3 bucket / DNS label rule)";
  }
  if (v.endsWith("-")) return "must not end with a hyphen (S3/DNS label rule)";
  if (v.includes("--")) return "must not contain consecutive hyphens";
  return null;
}

function validateAgentId(v: string): string | null {
  if (v.length < 1 || v.length > 39) return "must be 1–39 characters";
  if (!/^[a-z][a-z0-9-]*$/.test(v)) {
    return "must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (used in filesystem paths, systemd unit names, env var names, and NATS subjects)";
  }
  if (v.endsWith("-")) return "must not end with a hyphen";
  return null;
}

function validateTargetId(v: string): string | null {
  if (v.length < 1 || v.length > 39) return "must be 1–39 characters";
  if (!/^[a-z][a-z0-9-]*$/.test(v)) {
    return "must start with a lowercase letter and contain only lowercase letters, digits, and hyphens";
  }
  if (v.endsWith("-")) return "must not end with a hyphen";
  return null;
}

function validateSkillName(v: string): string | null {
  if (v.length < 1 || v.length > 128) return "must be 1–128 characters";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(v)) {
    return "must start with a lowercase letter or digit and contain only lowercase letters, digits, '.', '_', and '-' (used in install shell commands and filesystem paths)";
  }
  if (v.includes("..")) return "must not contain '..' (path traversal)";
  return null;
}

function validateNatsSubjectPrefix(v: string): string | null {
  if (v.length < 1 || v.length > 64) return "must be 1–64 characters";
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(v)) {
    return "must be dot-separated tokens of letters, digits, '_', or '-' with no spaces or NATS wildcards ('*', '>')";
  }
  return null;
}

// ── Identifier kind factory ──────────────────────────────────────────────────

export interface IdentifierKind<B extends string> {
  /** Human-readable label used in error messages. */
  readonly label: string;
  /** Type guard — true when `value` is a valid identifier of this kind. */
  is(value: string): value is Brand<string, B>;
  /** Validate and brand, or throw with a descriptive error. `context`
   *  (e.g. "agents.list[0].id") is woven into the message when provided. */
  parse(value: string, context?: string): Brand<string, B>;
  /** Zod schema that validates and brands. Surfaces the path-aware error from
   *  the surrounding object schema. */
  readonly schema: z.ZodType<Brand<string, B>, z.ZodTypeDef, string>;
}

function defineIdentifier<B extends string>(
  label: string,
  validate: (value: string) => string | null
): IdentifierKind<B> {
  type T = Brand<string, B>;
  const is = (value: string): value is T => validate(value) === null;
  const parse = (value: string, context?: string): T => {
    const err = validate(value);
    if (err) {
      const where = context ? ` (${context})` : "";
      throw new Error(`Invalid ${label} "${value}"${where}: ${err}`);
    }
    return value as T;
  };
  const schema = z
    .string()
    .superRefine((value, ctx) => {
      const err = validate(value);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    })
    .transform((value) => value as T);
  return { label, is, parse, schema };
}

export const FleetNameId = defineIdentifier<"FleetName">("fleet name", validateFleetName);
export const AgentIdId = defineIdentifier<"AgentId">("agent id", validateAgentId);
export const TargetIdId = defineIdentifier<"TargetId">("target id", validateTargetId);
export const SkillNameId = defineIdentifier<"SkillName">("skill name", validateSkillName);
export const NatsSubjectPrefixId = defineIdentifier<"NatsSubjectPrefix">(
  "NATS subject prefix",
  validateNatsSubjectPrefix
);

// Zod schemas for use in the wire schema (validate + brand at parse time).
export const FleetNameSchema = FleetNameId.schema;
export const AgentIdSchema = AgentIdId.schema;
export const TargetIdSchema = TargetIdId.schema;
export const SkillNameSchema = SkillNameId.schema;
export const NatsSubjectPrefixSchema = NatsSubjectPrefixId.schema;

// ── Convention helpers ────────────────────────────────────────────────────────

/** Env var prefix for an agent: `conductor` → `CONDUCTOR`, `pm-bot` → `PM_BOT`.
 *  Safe because an AgentId starts with a letter and contains only
 *  `[a-z0-9-]`, so the result is always a valid env var identifier. */
export function agentEnvPrefix(id: AgentId): string {
  return id.toUpperCase().replaceAll("-", "_");
}
