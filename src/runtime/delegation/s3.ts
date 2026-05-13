/**
 * FleetMind delegation — S3 client + narrative read/write.
 *
 * Narrative .md files (free-form task content) live in S3. Structured state
 * (status, timestamps, lifecycle) lives in DynamoDB. This module handles only
 * the S3 side.
 *
 * Local fallback: if the S3 write fails, the narrative is written to
 * ~/.fleetmind/ledger-pending/<task-id>-<event>.md so a heartbeat can retry.
 *
 * Design doc: docs/protocol.md §S3 schema
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdirSync } from "fs";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

export interface NarrativeStoreConfig {
  bucket: string;
  region?: string;
}

// ── S3 client factory ─────────────────────────────────────────────────────────

function makeS3Client(region?: string): S3Client {
  return new S3Client({
    region: region ?? process.env["AWS_REGION"] ?? "us-east-1",
  });
}

// ── Fallback path ─────────────────────────────────────────────────────────────

function pendingDir(): string {
  const dir = join(homedir(), ".fleetmind", "ledger-pending");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFallback(taskId: string, event: string, body: string): void {
  const path = join(pendingDir(), `${taskId}-${event}.md`);
  writeFileSync(path, body, "utf-8");
}

// ── Main class ────────────────────────────────────────────────────────────────

export class NarrativeStore {
  private s3: S3Client;
  private bucket: string;

  constructor(config: NarrativeStoreConfig) {
    this.bucket = config.bucket;
    this.s3 = makeS3Client(config.region);
  }

  /**
   * Read a narrative .md file from S3.
   * Returns the file content as a string, or undefined if not found.
   */
  async getNarrative(s3Key: string): Promise<string | undefined> {
    const result = await this.getNarrativeWithMeta(s3Key);
    return result?.body;
  }

  /**
   * Read a narrative .md file from S3, returning body + metadata.
   * Returns undefined if not found.
   */
  async getNarrativeWithMeta(
    s3Key: string
  ): Promise<{ body: string; lastModified?: string } | undefined> {
    try {
      const result = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
        })
      );
      if (!result.Body) return undefined;
      const body = await result.Body.transformToString("utf-8");
      const lastModified = result.LastModified?.toISOString();
      return { body, lastModified };
    } catch (err: unknown) {
      const code =
        err instanceof Error && "Code" in err
          ? (err as { Code?: string }).Code
          : undefined;
      if (code === "NoSuchKey" || code === "AccessDenied") {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Write a narrative .md file to S3.
   * Falls back to local disk if the S3 write fails.
   * Does NOT throw on S3 failure — returns a result object so callers can
   * decide whether to proceed with the DDB status update.
   *
   * IMPORTANT: The DDB status update should only fire AFTER this method
   * returns { ok: true }. Never update DDB before the narrative is durable.
   */
  async putNarrative(
    s3Key: string,
    body: string,
    opts?: { fallbackEvent?: string; taskId?: string; event?: string }
  ): Promise<{ ok: boolean; fallback?: string }> {
    const event = opts?.event ?? opts?.fallbackEvent ?? "event";
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: body,
          ContentType: "text/markdown",
          Metadata: {
            "x-amz-meta-event": event,
          },
        })
      );
      return { ok: true };
    } catch (err) {
      // Fall back to local pending queue — do not block the Slack reply.
      const taskId = opts?.taskId ?? s3Key.split("/").pop()?.replace(".md", "") ?? "unknown";
      try {
        writeFallback(taskId, event, body);
      } catch {
        // Ignore fallback write errors — we've already lost the S3 write.
      }
      const fallbackPath = join(pendingDir(), `${taskId}-${event}.md`);
      console.warn(
        `[fleetmind/delegation] S3 write failed for ${s3Key}: ${String(err)}. ` +
          `Wrote fallback to ${fallbackPath}.`
      );
      return { ok: false, fallback: fallbackPath };
    }
  }
}

// ── Narrative template helpers ────────────────────────────────────────────────

/** Build the standard narrative markdown for a shipped task */
export function buildShipNarrative(opts: {
  taskId: string;
  taskDescription: string;
  whatIDid: string;
  whatIDidntDo: string;
  links?: string[];
  learned?: string[];
}): string {
  const links =
    opts.links && opts.links.length > 0
      ? opts.links.map((l) => `- ${l}`).join("\n")
      : "- (none)";
  const learned =
    opts.learned && opts.learned.length > 0
      ? opts.learned.map((l) => `- ${l}`).join("\n")
      : "[]";

  return `---
v: 0.2
task_id: ${opts.taskId}
---

## Task
${opts.taskDescription}

## What I did
${opts.whatIDid}

## What I didn't do
${opts.whatIDidntDo}

## Links
${links}

## Learned
${learned}
`;
}

/** Build the standard narrative markdown for a blocked task */
export function buildBlockNarrative(opts: {
  taskId: string;
  taskDescription: string;
  whatITried: string;
  need: string;
  learned?: string[];
}): string {
  const learned =
    opts.learned && opts.learned.length > 0
      ? opts.learned.map((l) => `- ${l}`).join("\n")
      : "[]";

  return `---
v: 0.2
task_id: ${opts.taskId}
---

## Task
${opts.taskDescription}

## What I tried
${opts.whatITried}

## Need
${opts.need}

## Learned
${learned}
`;
}
