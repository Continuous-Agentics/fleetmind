/**
 * FleetMind delegation — DynamoDB client + conditional-write logic.
 *
 * All task lifecycle state transitions flow through this module. Each write
 * uses a ConditionExpression that enforces the state machine from docs/protocol.md:
 *
 *   PutItem (delegated):  attribute_not_exists(PK)
 *   accepted:             status = delegated AND worker = :worker
 *   shipped:              status = accepted  AND worker = :worker
 *   signed_off:           status = shipped   AND lifecycle = requires-human-signoff
 *   merged:               (status = shipped AND lifecycle = shipped-is-done) OR status = signed_off
 *   blocked:              status IN (delegated, accepted) AND worker = :worker
 *   abandoned:            status NOT IN (merged, abandoned)
 *
 * Design doc: docs/protocol.md §Conditional-write rules
 */

import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  TaskRecord,
  TaskRecordSchema,
  TaskStatus,
  TaskSummary,
  CreateTaskInput,
  DEFAULT_S3_KEY_TEMPLATE,
  gsi1pk,
  gsi2pk,
  taskPK,
  renderS3Key,
} from "./types.js";

// ── Client factory ────────────────────────────────────────────────────────────

export interface DelegationDDBConfig {
  tableName: string;
  region?: string;
}

function makeDocClient(region?: string): DynamoDBDocumentClient {
  const resolved =
    region ?? process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
  if (!resolved) {
    throw new Error(
      "DynamoDB region not configured. Set delegation.aws_region in fleet.yaml, " +
        "or export AWS_REGION / AWS_DEFAULT_REGION before invoking the CLI.",
    );
  }
  const client = new DynamoDBClient({ region: resolved });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function expiresAt365(): number {
  return Math.floor(Date.now() / 1000) + 365 * 86400;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Distinguish a ConditionExpression failure (state machine violation) from a
 * real network/service error. Returns true only for ConditionalCheckFailed.
 */
function isConditionFailed(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class TaskLedger {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor(config: DelegationDDBConfig) {
    this.table = config.tableName;
    this.doc = makeDocClient(config.region);
  }

  // ── Create (PM bot only) ──────────────────────────────────────────────────

  /**
   * Write the initial task record. Uses attribute_not_exists(PK) to prevent
   * overwriting an existing task.
   *
   * Throws if the task_id already exists (caller should regenerate the ID).
   */
  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const now = input.delegated_at ?? nowISO();
    const date = todayUTC();
    const template = input.s3_key_template ?? DEFAULT_S3_KEY_TEMPLATE;
    const s3Key = renderS3Key(template, {
      project: input.project,
      date,
      task_id: input.task_id,
    });

    const item: TaskRecord = {
      PK: taskPK(input.task_id),
      task_id: input.task_id,
      v: "0.2",
      project: input.project,
      status: "delegated",
      GSI1PK: gsi1pk(input.project, "delegated"),
      GSI2PK: gsi2pk("delegated"),
      delegated_by: input.delegated_by,
      worker: input.worker,
      delegated_at: now,
      lifecycle: input.lifecycle ?? "requires-human-signoff",
      definition_of_done: input.definition_of_done,
      delegation_thread: input.delegation_thread ?? "",
      delegation_envelope_ts: input.delegation_envelope_ts ?? "",
      tracker_link: input.tracker_link ?? null,
      ...(input.description ? { description: input.description } : {}),
      ...(input.requestor ? { requestor: input.requestor } : {}),
      task_s3_key: s3Key,
      expires_at: expiresAt365(),
    };

    // Validate the item before writing
    TaskRecordSchema.parse(item);

    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );

    return item;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Get a task record by task_id. Returns undefined if not found.
   */
  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: taskPK(taskId) },
      })
    );
    if (!result.Item) return undefined;
    return TaskRecordSchema.parse(result.Item);
  }

  // ── Lifecycle transitions ─────────────────────────────────────────────────

  /**
   * Worker acknowledges a delegation.
   * Condition: status = delegated AND worker = :worker
   *
   * `project` is required for GSI key updates. Pass it from a prior GetItem
   * (the skill always reads the task at receive time) to avoid a round-trip.
   */
  async ackTask(taskId: string, worker: string, project?: string): Promise<void> {
    const now = nowISO();
    const proj = project ?? (await this._getProject(taskId));
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :accepted, accepted_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      conditionExpression: "#st = :delegated AND #worker = :worker",
      expressionAttributeNames: { "#st": "status", "#worker": "worker" },
      expressionAttributeValues: {
        ":accepted": "accepted",
        ":delegated": "delegated",
        ":worker": worker,
        ":now": now,
        ":gsi1pk": gsi1pk(proj, "accepted"),
        ":gsi2pk": gsi2pk("accepted"),
      },
      errorContext: "ack (delegated→accepted)",
    });
  }

  /**
   * Worker ships a task.
   * Condition: status = accepted AND worker = :worker
   *
   * `project` is optional — if omitted, fetched via GetItem first.
   */
  async shipTask(taskId: string, worker: string, project?: string): Promise<void> {
    const now = nowISO();
    const proj = project ?? (await this._getProject(taskId));
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :shipped, shipped_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      conditionExpression: "#st = :accepted AND #worker = :worker",
      expressionAttributeNames: { "#st": "status", "#worker": "worker" },
      expressionAttributeValues: {
        ":shipped": "shipped",
        ":accepted": "accepted",
        ":worker": worker,
        ":now": now,
        ":gsi1pk": gsi1pk(proj, "shipped"),
        ":gsi2pk": gsi2pk("shipped"),
      },
      errorContext: "ship (accepted→shipped)",
    });
  }

  /**
   * Block a task.
   * Condition: status IN (delegated, accepted) AND worker = :worker
   *
   * `project` is optional — if omitted, fetched via GetItem first.
   */
  async blockTask(taskId: string, worker: string, project?: string): Promise<void> {
    const now = nowISO();
    const proj = project ?? (await this._getProject(taskId));
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :blocked, blocked_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      // DDB ConditionExpression doesn't support IN() with attribute; use OR
      conditionExpression:
        "(#st = :delegated OR #st = :accepted) AND #worker = :worker",
      expressionAttributeNames: { "#st": "status", "#worker": "worker" },
      expressionAttributeValues: {
        ":blocked": "blocked",
        ":delegated": "delegated",
        ":accepted": "accepted",
        ":worker": worker,
        ":now": now,
        ":gsi1pk": gsi1pk(proj, "blocked"),
        ":gsi2pk": gsi2pk("blocked"),
      },
      errorContext: "block (delegated|accepted→blocked)",
    });
  }

  /**
   * Unblock a task (blocked → accepted).
   * Condition: status = blocked
   *
   * Clears blocked_at / blocked_reason; sets unblocked_at (and optionally
   * unblocked_reason). Updates both GSI keys to accepted.
   *
   * Two-call sequence: first fetches the existing record to read the project
   * slug (needed for GSI1PK), then issues the conditional update.
   * `project` may be passed to skip the GetItem.
   */
  async unblockTask(
    taskId: string,
    worker: string,
    reason?: string,
    project?: string
  ): Promise<void> {
    const now = nowISO();
    const proj = project ?? (await this._getProject(taskId));
    const reasonExpr = reason ? ", unblocked_reason = :reason" : "";
    const reasonValues: Record<string, unknown> = reason
      ? { ":reason": reason }
      : {};
    await this._updateStatus(taskId, {
      updateExpression:
        `SET #st = :accepted, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk, unblocked_at = :now${reasonExpr} REMOVE blocked_at, blocked_reason`,
      conditionExpression: "attribute_exists(PK) AND #st = :expected",
      expressionAttributeNames: { "#st": "status" },
      expressionAttributeValues: {
        ":expected": "blocked",
        ":accepted": "accepted",
        ":gsi1pk": gsi1pk(proj, "accepted"),
        ":gsi2pk": gsi2pk("accepted"),
        ":now": now,
        ...reasonValues,
      },
      errorContext: "unblock (blocked→accepted)",
    });
  }

  /**
   * Human (or sign-off skill) signs off on a shipped task.
   * Condition: status = shipped AND lifecycle = requires-human-signoff
   *
   * `project` is optional — if omitted, fetched via GetItem first.
   */
  async signoffTask(taskId: string, project?: string): Promise<void> {
    const now = nowISO();
    const proj = project ?? (await this._getProject(taskId));
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :signed_off, signed_off_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      conditionExpression:
        "#st = :shipped AND lifecycle = :requires_signoff",
      expressionAttributeNames: { "#st": "status" },
      expressionAttributeValues: {
        ":signed_off": "signed_off",
        ":shipped": "shipped",
        ":requires_signoff": "requires-human-signoff",
        ":now": now,
        ":gsi1pk": gsi1pk(proj, "signed_off"),
        ":gsi2pk": gsi2pk("signed_off"),
      },
      errorContext: "signoff (shipped→signed_off)",
    });
  }

  /**
   * Mark a task merged.
   * Condition: (status = shipped AND lifecycle = shipped-is-done) OR status = signed_off
   *
   * Requires-human-signoff tasks CANNOT merge directly from shipped — they must
   * pass through signed_off first. Only shipped-is-done tasks may merge straight
   * from the shipped state.
   *
   * `project` is optional — if omitted, fetched via GetItem first.
   */
  async mergeTask(taskId: string, project?: string): Promise<void> {
    const now = nowISO();
    const proj = project ?? (await this._getProject(taskId));
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :merged, merged_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      conditionExpression: "(#st = :shipped AND lifecycle = :shipped_is_done) OR #st = :signed_off",
      expressionAttributeNames: { "#st": "status" },
      expressionAttributeValues: {
        ":merged": "merged",
        ":shipped": "shipped",
        ":signed_off": "signed_off",
        ":shipped_is_done": "shipped-is-done",
        ":now": now,
        ":gsi1pk": gsi1pk(proj, "merged"),
        ":gsi2pk": gsi2pk("merged"),
      },
      errorContext: "merge (shipped|signed_off→merged)",
    });
  }

  /**
   * Abandon a task (PM bot only).
   * Condition: status NOT IN (merged, abandoned)
   * Implemented as: status <> merged AND status <> abandoned
   *
   * `project` is optional — if omitted, fetched via GetItem first.
   */
  async abandonTask(taskId: string, project?: string): Promise<void> {
    const now = nowISO();
    const proj = project ?? (await this._getProject(taskId));
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :abandoned, abandoned_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      conditionExpression: "#st <> :merged AND #st <> :abandoned",
      expressionAttributeNames: { "#st": "status" },
      expressionAttributeValues: {
        ":abandoned": "abandoned",
        ":merged": "merged",
        ":now": now,
        ":gsi1pk": gsi1pk(proj, "abandoned"),
        ":gsi2pk": gsi2pk("abandoned"),
      },
      errorContext: "abandon (*→abandoned)",
    });
  }

  /**
   * Update mutable task metadata fields in-place.
   *
   * Only updates the fields present in `updates`. Always sets `updated_at` and
   * `updated_by`. If `reason` is provided, appends an entry to `update_history`
   * (bounded to 20 entries via a post-trim pass).
   *
   * If `updates.project` is present, also re-derives GSI1PK from the new
   * project slug + current task status (fetched via GetItem).
   *
   * Conditions:
   *   - Task must exist: attribute_exists(PK)
   *   - Status must NOT be merged or abandoned (terminal tasks are frozen)
   */
  async updateTaskMetadata(
    taskId: string,
    updates: {
      title?: string;
      description?: string;
      definition_of_done?: string;
      worker_id?: string;
      thread_url?: string;
      envelope_ts?: string;
      project?: string;
    },
    options?: {
      by?: string;
      reason?: string;
    }
  ): Promise<TaskRecord> {
    const now = nowISO();
    const by = options?.by ?? this._resolveUpdatedBy();

    // Fetch current record (needed for GSI1PK if project changes, and for validation)
    const current = await this.getTask(taskId);
    if (!current) {
      throw new TaskConditionError(
        `Task not found: ${taskId}. Cannot update metadata of a non-existent task.`
      );
    }
    if (current.status === "merged" || current.status === "abandoned") {
      throw new TaskConditionError(
        `Task ${taskId} is in terminal status '${current.status}'. Terminal tasks are frozen — metadata cannot be updated.`
      );
    }

    // Build SET expression dynamically
    const setParts: string[] = [];
    const exprNames: Record<string, string> = {};
    const exprValues: Record<string, unknown> = {};
    const fieldsChanged: string[] = [];

    if (updates.title !== undefined) {
      setParts.push("title = :title");
      exprValues[":title"] = updates.title;
      fieldsChanged.push("title");
    }
    if (updates.description !== undefined) {
      setParts.push("description = :description");
      exprValues[":description"] = updates.description;
      fieldsChanged.push("description");
    }
    if (updates.definition_of_done !== undefined) {
      setParts.push("definition_of_done = :dod");
      exprValues[":dod"] = updates.definition_of_done;
      fieldsChanged.push("definition_of_done");
    }
    if (updates.worker_id !== undefined) {
      setParts.push("#worker = :worker_id");
      exprNames["#worker"] = "worker";
      exprValues[":worker_id"] = updates.worker_id;
      fieldsChanged.push("worker");
    }
    if (updates.thread_url !== undefined) {
      setParts.push("delegation_thread = :thread_url");
      exprValues[":thread_url"] = updates.thread_url;
      fieldsChanged.push("delegation_thread");
    }
    if (updates.envelope_ts !== undefined) {
      setParts.push("delegation_envelope_ts = :envelope_ts");
      exprValues[":envelope_ts"] = updates.envelope_ts;
      fieldsChanged.push("delegation_envelope_ts");
    }
    if (updates.project !== undefined) {
      const newGsi1 = gsi1pk(updates.project, current.status);
      setParts.push("#proj = :project");
      setParts.push("GSI1PK = :gsi1pk");
      exprNames["#proj"] = "project";
      exprValues[":project"] = updates.project;
      exprValues[":gsi1pk"] = newGsi1;
      fieldsChanged.push("project");
    }

    // Always update metadata fields
    setParts.push("updated_at = :updated_at");
    setParts.push("updated_by = :updated_by");
    exprValues[":updated_at"] = now;
    exprValues[":updated_by"] = by;

    // Append to update_history if reason provided
    if (options?.reason !== undefined) {
      setParts.push(
        "update_history = list_append(if_not_exists(update_history, :empty), :new_entry)"
      );
      exprValues[":empty"] = [];
      exprValues[":new_entry"] = [
        {
          at: now,
          by,
          reason: options.reason,
          fields_changed: fieldsChanged,
        },
      ];
    }

    const updateExpression = `SET ${setParts.join(", ")}`;

    // Condition: task exists AND status is not terminal
    const conditionExpression =
      "attribute_exists(PK) AND #st <> :merged AND #st <> :abandoned";
    exprNames["#st"] = "status";
    exprValues[":merged"] = "merged";
    exprValues[":abandoned"] = "abandoned";

    try {
      const nameCount = Object.keys(exprNames).length;
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: taskPK(taskId) },
          UpdateExpression: updateExpression,
          ConditionExpression: conditionExpression,
          ...(nameCount > 0 && { ExpressionAttributeNames: exprNames }),
          ExpressionAttributeValues: exprValues,
        })
      );
    } catch (err) {
      if (isConditionFailed(err)) {
        throw new TaskConditionError(
          `Condition check failed for updateTaskMetadata on task ${taskId}. ` +
            `Task may be terminal or not exist — check with 'fleetmind task get ${taskId}'.`
        );
      }
      throw err;
    }

    // Post-trim: if update_history is growing, trim to last 20 entries.
    // We do a best-effort re-read and conditional trim — acceptable for v1.
    if (options?.reason !== undefined) {
      const after = await this.getTask(taskId);
      if (after?.update_history && after.update_history.length > 20) {
        const trimmed = after.update_history.slice(-20);
        await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { PK: taskPK(taskId) },
            UpdateExpression: "SET update_history = :trimmed",
            ExpressionAttributeValues: { ":trimmed": trimmed },
          })
        );
      }
    }

    // Return the updated record
    const result = await this.getTask(taskId);
    if (!result) throw new Error(`Task ${taskId} disappeared after update — DDB error?`);
    return result;
  }

  /** Resolve the `updated_by` identity from the environment. */
  private _resolveUpdatedBy(): string {
    // Try agent.env (fleetmind bot convention)
    try {
      const { readFileSync } = require("fs") as typeof import("fs");
      const env = readFileSync("/etc/fleetmind/agent.env", "utf8");
      const match = /^AGENT_ID=(.+)$/m.exec(env);
      if (match?.[1]) return match[1].trim();
    } catch {
      // file not present — not on a bot host
    }
    return process.env["USER"] ?? "unknown";
  }

  /**
   * Set `last_nag_at` to now. Idempotent — used by PM heartbeat to track
   * when it last pinged about a stale shipped task.
   */
  async setNag(taskId: string): Promise<void> {
    const now = nowISO();
    await this._updateStatus(taskId, {
      updateExpression: "SET last_nag_at = :now",
      conditionExpression: "attribute_exists(PK)",
      expressionAttributeNames: {},
      expressionAttributeValues: { ":now": now },
      errorContext: "set-nag",
    });
  }

  // ── GSI queries ───────────────────────────────────────────────────────────

  /**
   * Query the ProjectStatusIndex.
   * Returns all tasks for a given project+status, optionally filtered by
   * delegated_at < threshold (for stale-task escalation).
   */
  async queryByProjectStatus(opts: {
    project: string;
    status: TaskStatus;
    /** ISO 8601 — only return tasks delegated before this time */
    olderThan?: string;
    limit?: number;
    ascending?: boolean;
  }): Promise<TaskSummary[]> {
    const pk = gsi1pk(opts.project, opts.status);
    const input: QueryCommandInput = {
      TableName: this.table,
      IndexName: "ProjectStatusIndex",
      KeyConditionExpression: opts.olderThan
        ? "GSI1PK = :pk AND delegated_at < :threshold"
        : "GSI1PK = :pk",
      ExpressionAttributeValues: opts.olderThan
        ? { ":pk": pk, ":threshold": opts.olderThan }
        : { ":pk": pk },
      ScanIndexForward: opts.ascending !== false,
      Limit: opts.limit,
    };
    return this._queryToSummary(input);
  }

  /**
   * Query the StatusIndex (cross-project).
   * Returns all tasks with a given status, optionally filtered by
   * delegated_at < threshold.
   */
  async queryByStatus(opts: {
    status: TaskStatus;
    olderThan?: string;
    limit?: number;
    ascending?: boolean;
  }): Promise<TaskSummary[]> {
    const pk = gsi2pk(opts.status);
    const input: QueryCommandInput = {
      TableName: this.table,
      IndexName: "StatusIndex",
      KeyConditionExpression: opts.olderThan
        ? "GSI2PK = :pk AND delegated_at < :threshold"
        : "GSI2PK = :pk",
      ExpressionAttributeValues: opts.olderThan
        ? { ":pk": pk, ":threshold": opts.olderThan }
        : { ":pk": pk },
      ScanIndexForward: opts.ascending !== false,
      Limit: opts.limit,
    };
    return this._queryToSummary(input);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _getProject(taskId: string): Promise<string> {
    const item = await this.getTask(taskId);
    if (!item) throw new Error(`Task not found: ${taskId}`);
    return item.project;
  }

  private async _updateStatus(
    taskId: string,
    opts: {
      updateExpression: string;
      conditionExpression: string;
      expressionAttributeNames: Record<string, string>;
      expressionAttributeValues: Record<string, unknown>;
      errorContext: string;
    }
  ): Promise<void> {
    try {
      const nameCount = Object.keys(opts.expressionAttributeNames).length;
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: taskPK(taskId) },
          UpdateExpression: opts.updateExpression,
          ConditionExpression: opts.conditionExpression,
          ...(nameCount > 0 && { ExpressionAttributeNames: opts.expressionAttributeNames }),
          ExpressionAttributeValues: opts.expressionAttributeValues,
        })
      );
    } catch (err) {
      if (isConditionFailed(err)) {
        throw new TaskConditionError(
          `Condition check failed for ${opts.errorContext} on task ${taskId}. ` +
            `Task may be in an unexpected state — check current status with 'fleetmind task get ${taskId}'.`
        );
      }
      throw err;
    }
  }

  private async _queryToSummary(
    input: QueryCommandInput
  ): Promise<TaskSummary[]> {
    const result = await this.doc.send(new QueryCommand(input));
    return (result.Items ?? []).map((item) => ({
      task_id: item["task_id"] as string,
      project: item["project"] as string,
      status: item["status"] as TaskStatus,
      delegated_at: item["delegated_at"] as string,
      worker: item["worker"] as string,
      task_s3_key: item["task_s3_key"] as string,
    }));
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown when a DynamoDB ConditionExpression is violated.
 * Distinct from network errors — callers should not retry on this.
 */
export class TaskConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskConditionError";
  }
}
