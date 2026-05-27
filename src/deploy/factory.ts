/**
 * Provider selection — maps a fleet's target provider to the concrete deploy
 * adapters. This is the one place that decides "AWS vs local"; push-fleet and
 * pull-self call these rather than naming adapters directly.
 *
 * For now a fleet uses a single target provider (homogeneous). Mixed-provider
 * fleets (some agents on AWS, some on a Mac mini) are a future enhancement —
 * fleetProvider throws rather than silently picking one.
 */

import type { Fleet, TargetProvider } from "../config/schema.js";
import type { ArtifactStore, TargetResolver, CommandRunner } from "./transport.js";
import { S3ArtifactStore, SsmTargetResolver, SsmCommandRunner } from "./aws.js";
import { LocalFsArtifactStore, LocalTargetResolver, LocalCommandRunner, defaultLocalStoreRoot } from "./local.js";

/** The single target provider shared by all of the fleet's agents. Defaults to
 *  aws-ssm for a minimal/nameless fleet (no agents). Throws on a mix. */
export function fleetProvider(fleet: Fleet): TargetProvider {
  const providers = new Set<TargetProvider>();
  for (const agent of fleet.agents.list) {
    providers.add(fleet.targetForAgent(agent).provider);
  }
  if (providers.size === 0) return "aws-ssm";
  if (providers.size > 1) {
    throw new Error(
      `Mixed-provider fleets are not yet supported (found: ${[...providers].sort().join(", ")}). ` +
        `Use a single target provider for now.`
    );
  }
  return [...providers][0]!;
}

/** The artifact store for the fleet's bundles. local → a directory; everything
 *  else → S3 (the bucket from the deploy plan). */
export function artifactStoreFor(fleet: Fleet, opts: { bucket: string; region: string }): ArtifactStore {
  if (fleetProvider(fleet) === "local") {
    const store = fleet.deploy?.artifact_store;
    const root = store?.provider === "local-fs" ? store.local_fs.path : defaultLocalStoreRoot();
    return new LocalFsArtifactStore(root);
  }
  return new S3ArtifactStore(opts.bucket, opts.region);
}

/** How to resolve + run commands on the fleet's hosts. */
export function transportFor(
  provider: TargetProvider,
  ctx: { fleetName: string; region: string }
): { resolver: TargetResolver; runner: CommandRunner } {
  if (provider === "local") {
    return { resolver: new LocalTargetResolver(), runner: new LocalCommandRunner() };
  }
  // aws-ssm (ssh adapters land in the next sub-step).
  return {
    resolver: new SsmTargetResolver(ctx.fleetName, ctx.region),
    runner: new SsmCommandRunner(ctx.region),
  };
}
