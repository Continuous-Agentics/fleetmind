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
  UpdateDocumentDefaultVersionCommand,
  GetDocumentCommand,
  DocumentAlreadyExists,
} from "@aws-sdk/client-ssm";
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
        default: "--apply",
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
              "echo \"Running: sudo fleetmind self-upgrade \\\"$FLAG\\\" --apply\"",
              "sudo fleetmind self-upgrade \"$FLAG\" --apply",
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
  const docName = documentName(fleetName);
  const content = buildDocumentContent();

  // Check whether the document exists and whether its content matches.
  // We use GetDocument to retrieve the actual content and compare semantics
  // directly — more reliable than embedding a hash in the description field,
  // which breaks silently if the document is edited manually in the console.
  let existingContent: string | null = null;
  try {
    const resp = await ssm.send(
      new GetDocumentCommand({ Name: docName, DocumentFormat: "JSON" })
    );
    existingContent = resp.Content ?? null;
  } catch (err: unknown) {
    const errCode = (err as { name?: string }).name;
    // NoSuchDocument → document doesn't exist yet; all other errors re-throw
    if (errCode !== "NoSuchDocument") {
      throw err;
    }
  }

  // Normalize both sides before comparing to guard against SSM reformatting
  // JSON on ingest (e.g. key reordering, whitespace changes). Parsing and
  // re-serializing both strings ensures we compare semantics, not formatting.
  const normalize = (s: string): string => {
    try { return JSON.stringify(JSON.parse(s)); } catch { return s; }
  };
  if (existingContent !== null && normalize(existingContent) === normalize(content)) {
    log.dim(`  SSM document '${docName}' is current`);
    return docName;
  }

  if (existingContent === null) {
    // Create
    log.step(`  Creating SSM Automation document '${docName}'...`);
    try {
      await ssm.send(
        new CreateDocumentCommand({
          Name: docName,
          Content: content,
          DocumentType: "Automation",
          DocumentFormat: "JSON",
        })
      );
      log.ok(`  Created SSM document '${docName}'`);
    } catch (err: unknown) {
      // Race condition: another push created it between our get and create
      if (err instanceof DocumentAlreadyExists) {
        log.dim(`  Document '${docName}' created concurrently — proceeding`);
      } else {
        throw err;
      }
    }
  } else {
    // Update: create a new document version then advance the default so that
    // StartAutomationExecution (which uses $DEFAULT when no DocumentVersion is
    // specified) picks up the new content. Without this second call, the update
    // creates a new version but automations keep running the old default.
    log.step(`  Updating SSM Automation document '${docName}' (content changed)...`);
    const updateResp = await ssm.send(
      new UpdateDocumentCommand({
        Name: docName,
        Content: content,
        DocumentFormat: "JSON",
        DocumentVersion: "$LATEST",
      })
    );
    const newVersion = updateResp.DocumentDescription?.DocumentVersion;
    if (!newVersion) {
      // This should never happen — SSM always returns the new version number
      // in the UpdateDocument response. If it does, failing loudly is safer
      // than proceeding: without UpdateDocumentDefaultVersion, automations
      // would silently keep running the old default version.
      throw new Error(
        `SSM UpdateDocument for '${docName}' succeeded but returned no DocumentVersion. ` +
        `Cannot advance default version — aborting to avoid running stale document content.`
      );
    }
    await ssm.send(
      new UpdateDocumentDefaultVersionCommand({
        Name: docName,
        DocumentVersion: newVersion,
      })
    );
    log.ok(`  Updated SSM document '${docName}' (now default version ${newVersion})`);
  }

  return docName;
}
