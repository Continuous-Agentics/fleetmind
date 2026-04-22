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

// Inject stored secrets into env before any command runs
injectSecrets();

const program = new Command();

program
  .name("fleetmind")
  .description("Deploy and manage OpenClaw multi-agent fleets")
  .version("0.3.0");

registerInit(program);
registerDeploy(program);
registerDiff(program);
registerRender(program);
registerWatch(program);
registerStatus(program);
registerPush(program);
registerAgent(program);
registerSecrets(program);

program.parse();
