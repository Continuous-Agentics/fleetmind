/**
 * FleetMind ContextStore — shared hive mind for a fleet.
 *
 * Backed by DynamoDB in production. Falls back to an in-memory Map
 * in local/dev mode (no AWS creds or provider: local in fleet.yaml).
 *
 * Key format: {fleetName}/{scope}/{key}
 *   e.g. "acme-fleet/shared/last-deploy"
 *        "acme-fleet/conductor/current-task"
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { log } from "../utils/log.js";

export interface ContextConfig {
  provider: "dynamodb" | "local";
  table?: string;
  region?: string;
  ttlDays?: number;
  fleetName: string;
}

interface ContextItem {
  pk: string;
  sk: string;
  value: string;
  updatedAt: string;
  ttl?: number;
}

export class ContextStore {
  private config: ContextConfig;
  private tableName: string;
  private docClient?: DynamoDBDocumentClient;
  private localStore: Map<string, ContextItem> = new Map();
  private isLocal: boolean;

  constructor(config: ContextConfig) {
    this.config = config;
    this.tableName = config.table ?? `fleetmind-${config.fleetName}`;
    this.isLocal = config.provider === "local";

    if (!this.isLocal) {
      try {
        const dynamo = new DynamoDBClient({
          region: config.region ?? process.env["AWS_REGION"] ?? "us-east-1",
        });
        this.docClient = DynamoDBDocumentClient.from(dynamo, {
          marshallOptions: { removeUndefinedValues: true },
        });
      } catch {
        log.warn(
          "ContextStore: failed to initialise DynamoDB client — falling back to local in-memory store"
        );
        this.isLocal = true;
      }
    } else {
      log.warn(
        "ContextStore: running in LOCAL mode — data is in-memory only and will NOT persist across restarts"
      );
    }
  }

  /** Fully qualified key: {fleetName}/{scope}/{key} */
  key(scope: string, key: string): string {
    return `${this.config.fleetName}/${scope}/${key}`;
  }

  async get(pk: string): Promise<unknown | undefined> {
    if (this.isLocal) {
      const item = this.localStore.get(pk);
      if (!item) return undefined;
      if (item.ttl && item.ttl < Math.floor(Date.now() / 1000)) {
        this.localStore.delete(pk);
        return undefined;
      }
      return JSON.parse(item.value) as unknown;
    }

    const result = await this.docClient!.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk: "context" },
      })
    );

    if (!result.Item) return undefined;
    return JSON.parse((result.Item as ContextItem).value) as unknown;
  }

  async set(pk: string, value: unknown, ttlDays?: number): Promise<void> {
    const effectiveTtlDays = ttlDays ?? this.config.ttlDays;
    const ttl = effectiveTtlDays
      ? Math.floor(Date.now() / 1000) + effectiveTtlDays * 86400
      : undefined;

    const item: ContextItem = {
      pk,
      sk: "context",
      value: JSON.stringify(value),
      updatedAt: new Date().toISOString(),
      ...(ttl !== undefined ? { ttl } : {}),
    };

    if (this.isLocal) {
      this.localStore.set(pk, item);
      return;
    }

    await this.docClient!.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      })
    );
  }

  async delete(pk: string): Promise<void> {
    if (this.isLocal) {
      this.localStore.delete(pk);
      return;
    }

    await this.docClient!.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk, sk: "context" },
      })
    );
  }

  /**
   * List all keys matching a prefix (e.g. "acme-fleet/shared/").
   * Note: DynamoDB Scan is used here — avoid calling this in hot paths.
   * For high-volume listing, add a GSI on a prefix attribute instead.
   */
  async list(prefix?: string): Promise<string[]> {
    if (this.isLocal) {
      const keys = [...this.localStore.keys()];
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    }

    const params = prefix
      ? {
          TableName: this.tableName,
          FilterExpression: "begins_with(pk, :prefix)",
          ExpressionAttributeValues: { ":prefix": prefix },
          ProjectionExpression: "pk",
        }
      : {
          TableName: this.tableName,
          ProjectionExpression: "pk",
        };

    const result = await this.docClient!.send(new ScanCommand(params));
    return (result.Items ?? []).map((item) => (item as { pk: string }).pk);
  }
}
