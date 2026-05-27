/**
 * Tests for the deploy planning module.
 *
 * These lock the artifact-store conventions that push-fleet.ts used to derive
 * inline (bucket name, S3 keys, on-host commands) so the behavior-preserving
 * extraction stays behavior-preserving, and they cover the one intentional
 * addition: honoring deploy.artifact_store when set.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet, type Fleet } from "../core/model.js";
import {
  agentArtifactKeys,
  resolveArtifactBucket,
  buildPullSelfCommand,
  buildUpgradeCommand,
  buildDeployPlan,
  DEPLOY_LOCK_KEY,
} from "../deploy/plan.js";

function makeFleet(opts: { deployBucket?: string } = {}): Fleet {
  const data: Record<string, unknown> = {
    fleet: { name: "demo-fleet" },
    targets: {
      host: {
        provider: "aws-ssm",
        os: "linux",
        service_manager: "systemd",
        workspace_base: "/home/ec2-user/.openclaw",
        aws: { region: "us-west-2" },
      },
    },
    agents: {
      defaults: { target: "host" },
      list: [
        { id: "conductor", name: "Conductor", orchestrator: true },
        { id: "forge", name: "Forge" },
      ],
    },
  };
  if (opts.deployBucket) {
    data.deploy = { artifact_store: { provider: "s3", s3: { bucket: opts.deployBucket } } };
  }
  return normalizeFleet(FleetSchema.parse(data));
}

describe("agentArtifactKeys", () => {
  it("derives the deploy-staging keys for an agent", () => {
    assert.deepEqual(agentArtifactKeys("conductor"), {
      tarballFilename: "conductor.tar.gz",
      tarball: "deploy-staging/conductor.tar.gz",
      manifest: "deploy-staging/conductor.manifest.json",
      historyPrefix: "deploy-staging/history/conductor/",
    });
  });
});

describe("resolveArtifactBucket", () => {
  it("falls back to <fleet>-ledger when no deploy block is set", () => {
    assert.equal(resolveArtifactBucket(makeFleet()), "demo-fleet-ledger");
  });
  it("honors deploy.artifact_store.s3.bucket when set", () => {
    assert.equal(resolveArtifactBucket(makeFleet({ deployBucket: "my-bucket" })), "my-bucket");
  });
});

describe("on-host command builders", () => {
  it("aws-ssm: runs as ec2-user with --region; --restart only when asked", () => {
    assert.equal(
      buildPullSelfCommand({ provider: "aws-ssm", restart: false, region: "us-west-2", agentId: "conductor" }),
      "sudo -u ec2-user fleetmind pull-self --apply --region us-west-2"
    );
    assert.equal(
      buildPullSelfCommand({ provider: "aws-ssm", restart: true, region: "eu-west-1", agentId: "conductor" }),
      "sudo -u ec2-user fleetmind pull-self --apply --restart --region eu-west-1"
    );
  });

  it("local: runs as the current user with --agent/--fleet, no sudo or region", () => {
    assert.equal(
      buildPullSelfCommand({
        provider: "local",
        restart: true,
        region: "us-west-2",
        agentId: "conductor",
        fleetPath: "/work/fleet.yaml",
      }),
      "fleetmind pull-self --apply --restart --agent conductor --fleet /work/fleet.yaml"
    );
  });
  it("upgrade uses --latest for 'latest' and --to for a pinned version", () => {
    assert.equal(buildUpgradeCommand("latest"), "sudo fleetmind self-upgrade --latest --apply");
    assert.equal(buildUpgradeCommand("0.5.3"), "sudo fleetmind self-upgrade --to 0.5.3 --apply");
  });
});

describe("buildDeployPlan", () => {
  it("plans bucket, lock key, and per-agent paths/keys", () => {
    const plan = buildDeployPlan(makeFleet(), {
      region: "us-west-2",
      version: "9.9.9",
      localBase: "/work",
      agentIds: ["conductor", "forge"],
    });
    assert.equal(plan.bucket, "demo-fleet-ledger");
    assert.equal(plan.lockKey, DEPLOY_LOCK_KEY);
    assert.equal(plan.version, "9.9.9");
    assert.equal(plan.agents.length, 2);

    const conductor = plan.agents.find((a) => a.agentId === "conductor")!;
    assert.equal(conductor.isOrchestrator, true);
    assert.equal(conductor.workspaceDir, path.join("/work", "rendered", "workspaces", "conductor"));
    assert.ok(conductor.ocJsonPath.endsWith(path.join("conductor", "openclaw.json")));
    assert.equal(conductor.keys.tarball, "deploy-staging/conductor.tar.gz");

    assert.equal(plan.agents.find((a) => a.agentId === "forge")!.isOrchestrator, false);
  });

  it("omits unknown agent ids from the plan (caller reports them separately)", () => {
    const plan = buildDeployPlan(makeFleet(), {
      region: "us-west-2",
      version: "1.0.0",
      localBase: "/work",
      agentIds: ["conductor", "ghost"],
    });
    assert.deepEqual(plan.agents.map((a) => a.agentId), ["conductor"]);
  });
});
