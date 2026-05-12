/**
 * FleetMind delegation — shared TypeScript types.
 *
 * Mirrors the DynamoDB schema defined in docs/protocol.md.
 * Zod schemas validate runtime data at DDB/S3 boundaries.
 */

import { z } from "zod";

// ── Status enum ──────────────────────────────────────────────────────────────

export const TaskStatusSchema = z.enum([
  "delegated",
  "accepted",
  "shipped",
  "signed_off",
  "merged",
  "blocked",
  "abandoned",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// ── Lifecycle ────────────────────────────────────────────────────────────────

export const LifecycleSchema = z.enum([
  "requires-human-signoff",
  "shipped-is-done",
]);
export type Lifecycle = z.infer<typeof LifecycleSchema>;

// ── DynamoDB task record ─────────────────────────────────────────────────────

/**
 * Raw DDB item shape (what DynamoDB returns via lib-dynamodb).
 * All fields use plain JS types — the Document Client unmarshals for us.
 */
export const TaskRecordSchema = z.object({
  /** PK: "TASK#<task_id>" */
  PK: z.string(),
  /** 8-char lowercase hex */
  task_id: z.string().regex(/^[0-9a-f]{8}$/),
  /** Schema version */
  v: z.string().default("0.2"),
  /** Project slug */
  project: z.string(),
  status: TaskStatusSchema,
  /** GSI1 hash key: "PROJECT#<slug>#STATUS#<status>" */
  GSI1PK: z.string(),
  /** GSI2 hash key: "STATUS#<status>" */
  GSI2PK: z.string(),
  /** PM bot identifier (Slack user ID or agent ID) */
  delegated_by: z.string(),
  /** Worker bot identifier */
  worker: z.string(),
  /** ISO 8601 delegation timestamp */
  delegated_at: z.string(),
  accepted_at: z.string().optional(),
  shipped_at: z.string().optional(),
  signed_off_at: z.string().optional(),
  merged_at: z.string().optional(),
  blocked_at: z.string().optional(),
  abandoned_at: z.string().optional(),
  /** ISO 8601 timestamp of the last nag sent by the PM bot for this task */
  last_nag_at: z.string().optional(),
  lifecycle: LifecycleSchema,
  definition_of_done: z.string(),
  /** Slack permalink or equivalent coordination-channel URL */
  delegation_thread: z.string(),
  delegation_envelope_ts: z.string(),
  tracker_link: z.string().nullable().optional(),
  /** S3 key for the narrative .md — e.g. "v0/projects/my-proj/tasks/2026-01-01-a1b2c3d4.md" */
  task_s3_key: z.string(),
  /** TTL epoch seconds */
  expires_at: z.number(),
});

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

// ── GSI key helpers ──────────────────────────────────────────────────────────

export function gsi1pk(project: string, status: TaskStatus): string {
  return `PROJECT#${project}#STATUS#${status}`;
}

export function gsi2pk(status: TaskStatus): string {
  return `STATUS#${status}`;
}

export function taskPK(taskId: string): string {
  return `TASK#${taskId}`;
}

// ── S3 narrative schema ──────────────────────────────────────────────────────

/** s3_key_template parameter substitution context */
export interface S3KeyContext {
  project: string;
  date: string; // YYYY-MM-DD
  task_id: string;
}

/**
 * Render the S3 key from a template string.
 * Template tokens: {project}, {date}, {task_id}
 */
export function renderS3Key(template: string, ctx: S3KeyContext): string {
  return template
    .replace("{project}", ctx.project)
    .replace("{date}", ctx.date)
    .replace("{task_id}", ctx.task_id);
}

export const DEFAULT_S3_KEY_TEMPLATE =
  "v0/projects/{project}/tasks/{date}-{task_id}.md";

// ── PutItem input shape (returned by ddb.buildCreateItem) ────────────────────

export interface CreateTaskInput {
  task_id: string;
  project: string;
  delegated_by: string;
  worker: string;
  definition_of_done: string;
  delegation_thread: string;
  delegation_envelope_ts: string;
  tracker_link?: string | null;
  lifecycle?: Lifecycle;
  /** Override the delegated_at timestamp (defaults to now) */
  delegated_at?: string;
  /** S3 key template; defaults to DEFAULT_S3_KEY_TEMPLATE */
  s3_key_template?: string;
}

// ── Query result shapes ──────────────────────────────────────────────────────

/** Slim projection of a task for heartbeat / query output */
export interface TaskSummary {
  task_id: string;
  project: string;
  status: TaskStatus;
  delegated_at: string;
  worker: string;
  task_s3_key: string;
}
