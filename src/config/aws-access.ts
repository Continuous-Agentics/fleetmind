import { z } from "zod";

export const AwsAccessAlias = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
// Commercial AWS only: existing FleetMind host infrastructure uses this partition.
export const AwsRoleArn = z.string().regex(/^arn:aws:iam::[0-9]{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]{1,64}$/);
export const AwsAccessTarget = z.object({
  app: AwsAccessAlias,
  environment: AwsAccessAlias,
  access: AwsAccessAlias,
  account_id: z.string().regex(/^[0-9]{12}$/),
  role_arn: AwsRoleArn,
  region: z.string().regex(/^[a-z]{2}-[a-z]+-[0-9]+$/),
  duration_seconds: z.number().int().min(900).max(3600).default(900),
}).strict().superRefine((target, ctx) => {
  if (target.role_arn.split(":")[4] !== target.account_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["role_arn"], message: "Role ARN account must equal account_id" });
  }
});
export const AwsAgentAccess = z.object({
  source_role_arn: AwsRoleArn,
  targets: z.array(AwsAccessAlias).refine(a => new Set(a).size === a.length, "Duplicate AWS access grant"),
}).strict();
export const AwsAccessCatalog = z.record(AwsAccessAlias, AwsAccessTarget);
export const RuntimeAwsAccess = z.object({
  version: z.literal(1),
  agent: AwsAccessAlias,
  source_role_arn: AwsRoleArn,
  source_region: z.string().regex(/^[a-z]{2}-[a-z]+-[0-9]+$/),
  targets: AwsAccessCatalog,
}).strict();
export type RuntimeAwsAccessConfig = z.infer<typeof RuntimeAwsAccess>;
export type AwsAccessTargetConfig = z.infer<typeof AwsAccessTarget>;

/** Host authority is operator-owned target configuration, independent of grants. */
export const AwsAccessHost = z.object({
  fleet: AwsAccessAlias,
  agent: AwsAccessAlias,
  account_id: z.string().regex(/^[0-9]{12}$/),
  role_arn: AwsRoleArn,
  region: z.string().regex(/^[a-z]{2}-[a-z]+-[0-9]+$/),
}).strict().superRefine((host, ctx) => {
  if (host.role_arn.split(":")[4] !== host.account_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Host role/account mismatch" });
});
export type AwsAccessHostConfig = z.infer<typeof AwsAccessHost>;

/** Operator-assigned desired-state sequence; never generated from delivery time. */
export const AwsAccessRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** One atomic file preserves the revision even when all grants are revoked. */
export const AwsAccessPublication = z.object({
  version: z.literal(1),
  revision: AwsAccessRevision,
  catalog: RuntimeAwsAccess.nullable(),
}).strict();
