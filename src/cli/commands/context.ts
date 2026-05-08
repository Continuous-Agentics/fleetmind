/**
 * fleetmind context — inspect and mutate the fleet's shared ContextStore
 *
 * Usage:
 *   fleetmind context get <key>
 *   fleetmind context set <key> <value>
 *   fleetmind context delete <key>
 *   fleetmind context list [prefix]
 */

import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { ContextStore } from "../../runtime/context.js";
import { log } from "../../utils/log.js";

function makeStore(fleetFile: string): ContextStore {
  const fleet = loadFleet(fleetFile);
  return new ContextStore({
    provider: fleet.context.provider,
    table: fleet.context.table,
    region: fleet.context.region,
    ttlDays: fleet.context.ttl_days,
    fleetName: fleet.fleet.name,
  });
}

export function registerContext(program: Command): void {
  const ctx = program
    .command("context")
    .description("Read and write shared fleet context (hive mind)");

  ctx
    .command("get <key>")
    .description("Get a value from the context store")
    .option("-f, --fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (key: string, opts: { fleet: string }) => {
      const store = makeStore(opts.fleet);
      const value = await store.get(key);
      if (value === undefined) {
        log.warn(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(JSON.stringify(value, null, 2));
    });

  ctx
    .command("set <key> <value>")
    .description("Set a value in the context store (value is parsed as JSON if valid, else stored as string)")
    .option("-f, --fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--ttl <days>", "TTL in days (overrides fleet default)")
    .action(async (key: string, rawValue: string, opts: { fleet: string; ttl?: string }) => {
      const store = makeStore(opts.fleet);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawValue);
      } catch {
        parsed = rawValue;
      }
      const ttl = opts.ttl ? parseInt(opts.ttl, 10) : undefined;
      await store.set(key, parsed, ttl);
      log.info(`Set: ${key}`);
    });

  ctx
    .command("delete <key>")
    .description("Delete a key from the context store")
    .option("-f, --fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (key: string, opts: { fleet: string }) => {
      const store = makeStore(opts.fleet);
      await store.delete(key);
      log.info(`Deleted: ${key}`);
    });

  ctx
    .command("list [prefix]")
    .description("List all keys, optionally filtered by prefix")
    .option("-f, --fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (prefix: string | undefined, opts: { fleet: string }) => {
      const store = makeStore(opts.fleet);
      const keys = await store.list(prefix);
      if (keys.length === 0) {
        log.info("No keys found");
        return;
      }
      keys.forEach((k) => console.log(k));
    });
}
