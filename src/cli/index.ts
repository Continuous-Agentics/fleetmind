#!/usr/bin/env node
/**
 * FleetMind CLI
 */
import { Command } from "commander";
import { injectSecrets } from "../utils/secrets.js";
import { registerInit } from "./commands/init.js";
import { registerDeploy } from "./commands/deploy.js";
import { registerDiff } from "./commands/diff.js";
import { registerRender } from "./commands/render.js";
import { registerWatch } from "./commands/watch.js";
import { registerStatus } from "./commands/status.js";
import { registerPush } from "./commands/push.js";
import { registerAgent } from "./commands/agent.js";
import { registerSecrets } from "./commands/secrets.js";
import { registerContext } from "./commands/context.js";
import { registerTask } from "./commands/task.js";
import { registerNarrative } from "./commands/narrative.js";
import { registerQuery } from "./commands/query.js";
import { registerGithubApp } from "./commands/github-app.js";
import { registerSelfUpgrade } from "./commands/self-upgrade.js";
import { registerSlackDiscover, registerSlackManifests } from "./commands/slack.js";
import { registerPullSelf } from "./commands/pull-self.js";

// Inject stored secrets into env before any command runs
injectSecrets();

// Read version from package.json so `fleetmind --version` reflects what was actually installed
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8")
) as { version: string };

const program = new Command();

program
  .name("fleetmind")
  .description("Deploy and manage OpenClaw multi-agent fleets")
  .version(pkg.version);

registerInit(program);
registerDeploy(program);
registerDiff(program);
registerRender(program);
registerWatch(program);
registerStatus(program);
registerPush(program);
registerAgent(program);
registerSecrets(program);
registerContext(program);
registerTask(program);
registerNarrative(program);
registerQuery(program);
registerGithubApp(program);
registerSelfUpgrade(program);
registerSlackDiscover(program);
registerSlackManifests(program);
registerPullSelf(program);

program.parse();
