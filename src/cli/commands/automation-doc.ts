/**
 * SSM Automation document management for FleetMind fleet operations.
 *
 * FleetMind uses a versioned SSM Automation document per fleet to sequence
 * multi-step agent operations (e.g. CLI upgrade → workspace sync). Running
 * these as a proper SSM Automation execution — rather than a chained shell
 * string in a single RunCommand — means:
 *
 *   - SSM owns the state machine; each step has its own status, stdout, stderr
 *   - onFailure: Abort on the upgrade step hard-stops the execution; pull-self
 *     never runs on a stale binary
 *   - The operator gets back an execution ID and can monitor/audit independently
 *     of the push fleet process
 *   - No operator-side polling loop sitting in the critical path
 *
 * Document name convention: FleetMind-{fleetName}-AgentUpdate (regional resource)
 *
 * The document is upserted (create or update to latest content) by push fleet
 * before starting any automation executions. This keeps the document in sync
 * with the CLI version that manages it without requiring a separate infra step.
 */

import {
  SSMClient,
  CreateDocumentCommand,
  UpdateDocumentCommand,
  DescribeDocumentCommand,
  DocumentAlreadyExists,
} from "@aws-sdk/client-ssm";
import crypto from "node:crypto";
import { log } from "../../utils/log.js";

// ── Document definition ───────────────────────────────────────────────────────

/**
 * Build the SSM Automation document content for the given fleet.
 *
 * Steps:
 *   1. UpgradeIfNeeded — runs 'sudo fleetmind self-upgrade <flag> --apply'
 *      when UpgradeFlag is non-empty. set -euo pipefail ensures a failed
 *      upgrade exits non-zero; onFailure: Abort prevents step 2 from running.
 *   2. SyncWorkspace — runs 'sudo -u ec2-user fleetmind pull-self <args>'.
 *      Only reached if step 1 succeeded (or was skipped).
 */
export function buildDocumentContent(): string {
  const doc = {
    schemaVersion: "0.3",
    description:
      "FleetMind: optionally upgrade the agent CLI, then sync the workspace. " +
      "The upgrade step gates pull-self — a failed upgrade aborts the execution " +
      "so pull-self never runs on a stale binary.",
    parameters: {
      InstanceId: {
        type: "String",
        description: "EC2 instance ID of the target agent.",
      },
      UpgradeFlag: {
        type: "String",
        description:
          "Flag to pass to 'fleetmind self-upgrade': '--latest' or '--version <semver>'. " +
          "Empty string skips the upgrade step.",
        default: "",
      },
      PullSelfArgs: {
        type: "String",
        description:
          "Arguments for 'fleetmind pull-self', e.g. '--apply --restart --region us-west-2'.",
      },
      AutomationAssumeRole: {
        type: "String",
        description:
          "IAM role ARN for the automation to assume. Leave empty to use the caller's permissions.",
        default: "",
      },
    },
    mainSteps: [
      {
        name: "UpgradeIfNeeded",
        action: "aws:runCommand",
        description:
          "Upgrade the fleetmind CLI when UpgradeFlag is set. " +
          "Exits non-zero on failure; onFailure: Abort prevents SyncWorkspace from running.",
        onFailure: "Abort",
        nextStep: "SyncWorkspace",
        inputs: {
          DocumentName: "AWS-RunShellScript",
          InstanceIds: ["{{ InstanceId }}"],
          Parameters: {
            commands: [
              "#!/bin/bash",
              "set -euo pipefail",
              "FLAG='{{ UpgradeFlag }}'",
              "if [ -z \"$FLAG\" ]; then",
              "  echo 'UpgradeFlag is empty — skipping CLI upgrade'",
              "  exit 0",
              "fi",
              "echo \"Running: sudo fleetmind self-upgrade $FLAG --apply\"",
              "sudo fleetmind self-upgrade $FLAG --apply",
            ],
          },
        },
      },
      {
        name: "SyncWorkspace",
        action: "aws:runCommand",
        description:
          "Sync the agent workspace from S3. Only runs if UpgradeIfNeeded succeeded.",
        onFailure: "Abort",
        isEnd: true,
        inputs: {
          DocumentName: "AWS-RunShellScript",
          InstanceIds: ["{{ InstanceId }}"],
          Parameters: {
            commands: [
              "#!/bin/bash",
              "set -euo pipefail",
              "echo \"Running: sudo -u ec2-user fleetmind pull-self {{ PullSelfArgs }}\"",
              "sudo -u ec2-user fleetmind pull-self {{ PullSelfArgs }}",
            ],
          },
        },
      },
    ],
  };
  return JSON.stringify(doc, null, 2);
}

/** Stable hash of the document content — used to detect whether an update is needed. */
function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** SSM Automation document name for a fleet. */
export function documentName(fleetName: string): string {
  return `FleetMind-${fleetName}-AgentUpdate`;
}

// ── Upsert logic ─────────────────────────────────────────────────────────────

/**
 * Ensure the SSM Automation document exists and is up to date.
 *
 * - Creates the document if it doesn't exist.
 * - Updates to a new version if the content has changed.
 * - No-ops if the document is already current.
 *
 * Returns the document name.
 */
export async function ensureAutomationDocument(
  fleetName: string,
  region: string,
  deps: { ssmClient?: SSMClient } = {}
): Promise<string> {
  const ssm = deps.ssmClient ?? new SSMClient({ region });
  const name = documentName(fleetName);
  const content = buildDocumentContent();
  const hash = contentHash(content);

  // Check whether the document already exists and whether its content matches.
  let existingHash: string | null = null;
  try {
    const desc = await ssm.send(new DescribeDocumentCommand({ Name: name }));
    // SSM doesn't expose content hash directly; we embed it in the document
    // description field as a lightweight change-detection mechanism.
    existingHash = desc.Document?.Description?.match(/sha256:([0-9a-f]{16})/)?.[1] ?? null;
  } catch (err: unknown) {
    // NoSuchDocument → document doesn't exist yet; any other error re-throws
    const name = (err as { name?: string }).name;
    if (name !== "NoSuchDocument" && name !== "InvalidDocument") {
      throw err;
    }
  }

  if (existingHash === hash) {
    log.dim(`  SSM document '${name}' is current (sha256:${hash})`);
    return name;
  }

  // Rebuild document content with hash embedded in description for change detection.
  const docWithHash = JSON.parse(content) as Record<string, unknown>;
  docWithHash.description =
    `FleetMind: optionally upgrade the agent CLI, then sync the workspace. ` +
    `The upgrade step gates pull-self — a failed upgrade aborts the execution ` +
    `so pull-self never runs on a stale binary. [sha256:${hash}]`;
  const finalContent = JSON.stringify(docWithHash, null, 2);

  if (existingHash === null) {
    // Create
    log.step(`  Creating SSM Automation document '${name}'...`);
    try {
      await ssm.send(
        new CreateDocumentCommand({
          Name: name,
          Content: finalContent,
          DocumentType: "Automation",
          DocumentFormat: "JSON",
        })
      );
      log.ok(`  Created SSM document '${name}'`);
    } catch (err: unknown) {
      // Race condition: another push created it between our describe and create
      if (err instanceof DocumentAlreadyExists) {
        log.dim(`  Document '${name}' created concurrently — proceeding`);
      } else {
        throw err;
      }
    }
  } else {
    // Update
    log.step(`  Updating SSM Automation document '${name}' (content changed)...`);
    await ssm.send(
      new UpdateDocumentCommand({
        Name: name,
        Content: finalContent,
        DocumentFormat: "JSON",
        DocumentVersion: "$LATEST",
      })
    );
    log.ok(`  Updated SSM document '${name}'`);
  }

  return name;
}
