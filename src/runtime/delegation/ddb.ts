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
 *   merged:               status IN (shipped, signed_off)
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
  const client = new DynamoDBClient({
    region: region ?? process.env["AWS_REGION"] ?? "us-east-1",
  });
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
      delegation_thread: input.delegation_thread,
      delegation_envelope_ts: input.delegation_envelope_ts,
      tracker_link: input.tracker_link ?? null,
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
   */
  async ackTask(taskId: string, worker: string): Promise<void> {
    const now = nowISO();
    const project = await this._getProject(taskId);
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
        ":gsi1pk": gsi1pk(project, "accepted"),
        ":gsi2pk": gsi2pk("accepted"),
      },
      errorContext: "ack (delegated→accepted)",
    });
  }

  /**
   * Worker ships a task.
   * Condition: status = accepted AND worker = :worker
   */
  async shipTask(taskId: string, worker: string): Promise<void> {
    const now = nowISO();
    const project = await this._getProject(taskId);
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
        ":gsi1pk": gsi1pk(project, "shipped"),
        ":gsi2pk": gsi2pk("shipped"),
      },
      errorContext: "ship (accepted→shipped)",
    });
  }

  /**
   * Block a task.
   * Condition: status IN (delegated, accepted) AND worker = :worker
   */
  async blockTask(taskId: string, worker: string): Promise<void> {
    const now = nowISO();
    const project = await this._getProject(taskId);
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
        ":gsi1pk": gsi1pk(project, "blocked"),
        ":gsi2pk": gsi2pk("blocked"),
      },
      errorContext: "block (delegated|accepted→blocked)",
    });
  }

  /**
   * Human (or sign-off skill) signs off on a shipped task.
   * Condition: status = shipped AND lifecycle = requires-human-signoff
   */
  async signoffTask(taskId: string): Promise<void> {
    const now = nowISO();
    const project = await this._getProject(taskId);
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
        ":gsi1pk": gsi1pk(project, "signed_off"),
        ":gsi2pk": gsi2pk("signed_off"),
      },
      errorContext: "signoff (shipped→signed_off)",
    });
  }

  /**
   * Mark a task merged.
   * Condition: status IN (shipped, signed_off)
   */
  async mergeTask(taskId: string): Promise<void> {
    const now = nowISO();
    const project = await this._getProject(taskId);
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :merged, merged_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      conditionExpression: "#st = :shipped OR #st = :signed_off",
      expressionAttributeNames: { "#st": "status" },
      expressionAttributeValues: {
        ":merged": "merged",
        ":shipped": "shipped",
        ":signed_off": "signed_off",
        ":now": now,
        ":gsi1pk": gsi1pk(project, "merged"),
        ":gsi2pk": gsi2pk("merged"),
      },
      errorContext: "merge (shipped|signed_off→merged)",
    });
  }

  /**
   * Abandon a task (PM bot only).
   * Condition: status NOT IN (merged, abandoned)
   * Implemented as: status <> merged AND status <> abandoned
   */
  async abandonTask(taskId: string): Promise<void> {
    const now = nowISO();
    const project = await this._getProject(taskId);
    await this._updateStatus(taskId, {
      updateExpression:
        "SET #st = :abandoned, abandoned_at = :now, GSI1PK = :gsi1pk, GSI2PK = :gsi2pk",
      conditionExpression: "#st <> :merged AND #st <> :abandoned",
      expressionAttributeNames: { "#st": "status" },
      expressionAttributeValues: {
        ":abandoned": "abandoned",
        ":merged": "merged",
        ":now": now,
        ":gsi1pk": gsi1pk(project, "abandoned"),
        ":gsi2pk": gsi2pk("abandoned"),
      },
      errorContext: "abandon (*→abandoned)",
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
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: taskPK(taskId) },
          UpdateExpression: opts.updateExpression,
          ConditionExpression: opts.conditionExpression,
          ExpressionAttributeNames: opts.expressionAttributeNames,
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
