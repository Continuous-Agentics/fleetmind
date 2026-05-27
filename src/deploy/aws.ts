/**
 * AWS adapters for the deploy transport contracts.
 *
 * This is the only deploy module that imports the AWS SDK. S3 backs the
 * ArtifactStore; SSM backs target resolution (tag lookup) and command running
 * (RunShellScript). Adding ssh/local backends means new files alongside this
 * one — not edits here.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  SendCommandCommand,
  DescribeInstanceInformationCommand,
} from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { ArtifactStore, TargetResolver, CommandRunner } from "./transport.js";

/**
 * SSMClient with explicit timeouts and a capped retry count: abort quickly on
 * an unreachable endpoint rather than hanging, and cap worst-case latency.
 */
function makeSsmClient(region: string): SSMClient {
  return new SSMClient({
    region,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
    }),
    maxAttempts: 2,
  });
}

/** S3-backed ArtifactStore. Bucket + region are bound at construction. */
export class S3ArtifactStore implements ArtifactStore {
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, region: string) {
    this.s3 = new S3Client({ region });
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const resp = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await resp.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${srcKey}`,
        Key: destKey,
      })
    );
  }

  async list(prefix: string): Promise<string[]> {
    const resp = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix })
    );
    return (resp.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Resolves an agent's EC2 instance id via SSM DescribeInstanceInformation tag
 *  filters. Tag keys match the fleetmind:* namespace set by the Terraform. */
export class SsmTargetResolver implements TargetResolver {
  private readonly ssm: SSMClient;
  constructor(private readonly fleetName: string, region: string) {
    this.ssm = makeSsmClient(region);
  }

  async resolveHost(agentId: string): Promise<string | null> {
    const resp = await this.ssm.send(
      new DescribeInstanceInformationCommand({
        Filters: [
          { Key: "tag:fleetmind:fleet_name", Values: [this.fleetName] },
          { Key: "tag:fleetmind:agent_id", Values: [agentId] },
        ],
      })
    );
    return resp.InstanceInformationList?.[0]?.InstanceId ?? null;
  }
}

/** Runs commands on an EC2 instance via SSM SendCommand (AWS-RunShellScript). */
export class SsmCommandRunner implements CommandRunner {
  private readonly ssm: SSMClient;
  constructor(region: string) {
    this.ssm = makeSsmClient(region);
  }

  async run(instanceId: string, commands: string[]): Promise<string> {
    const resp = await this.ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands },
      })
    );
    return resp.Command?.CommandId ?? "";
  }
}
