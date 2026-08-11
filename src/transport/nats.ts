/**
 * FleetMind NATS transport.
 *
 * Provides a thin publisher and subscriber layer over the NATS.io client
 * for inter-agent task delegation events.
 *
 * Subject naming convention (all relative to `subject_prefix`, default "fleetmind"):
 *
 *   {prefix}.delegation.{worker_id}        – PM → worker: new task delegation
 *   {prefix}.task.{task_id}.ack            – worker → PM: task acknowledged (auto on delegation receipt)
 *   {prefix}.task.{task_id}.progress       – worker → PM: mid-task progress update
 *   {prefix}.task.{task_id}.ship           – worker → PM: task shipped (human approved)
 *   {prefix}.task.{task_id}.block          – worker → PM: task blocked
 *
 * All messages are JSON-encoded TaskEvent objects.
 */

import {
  connect,
  NatsConnection,
  Subscription,
  StringCodec,
  ConnectionOptions,
} from "nats";
import type { NatsConfig } from "../config/schema.js";
import { log } from "../utils/log.js";

// ── Versioned event contracts ───────────────────────────────────────────────

export {
  allTaskEventsSubject,
  delegationSubject,
  taskSubject,
  type TaskEvent,
  type TaskEventType,
} from "@continuous-agentics/delegation-core";

import {
  TaskEventSchema,
  delegationSubject,
  taskSubject,
  allTaskEventsSubject,
  type TaskEvent,
  type TaskEventType,
} from "@continuous-agentics/delegation-core";

// ── Connection factory ────────────────────────────────────────────────────────

const sc = StringCodec();

/**
 * Open a NATS connection from a NatsConfig.
 *
 * Callers are responsible for calling `nc.drain()` / `nc.close()` when done.
 */
export async function openNatsConnection(cfg: NatsConfig): Promise<NatsConnection> {
  const opts: ConnectionOptions = {
    servers: cfg.servers,
    timeout: cfg.connect_timeout_ms,
    maxReconnectAttempts: cfg.max_reconnect,
    inboxPrefix: cfg.inbox_prefix,
    reconnect: true,
  };

  if (cfg.creds_file) {
    // Dynamic import so the creds path resolver only loads when needed.
    const { credsAuthenticator } = await import("nats");
    const { readFileSync, existsSync } = await import("fs");
    if (!existsSync(cfg.creds_file)) {
      throw new Error(`NATS creds_file not found: ${cfg.creds_file}`);
    }
    const creds = readFileSync(cfg.creds_file);
    opts.authenticator = credsAuthenticator(creds);
  }

  const nc = await connect(opts);
  return nc;
}

// ── Publisher ─────────────────────────────────────────────────────────────────

/**
 * Publish a single task event then close the connection.
 *
 * Suitable for one-shot publishes from CLI commands (task create, ship, block).
 */
export async function publishTaskEvent(
  cfg: NatsConfig,
  event: TaskEvent
): Promise<void> {
  const nc = await openNatsConnection(cfg);
  try {
    const subject = resolvePublishSubject(cfg.subject_prefix, event);
    const payload = sc.encode(JSON.stringify(event));
    nc.publish(subject, payload);
    // Flush before logging so we only claim success after delivery.
    await nc.flush();
    log.info(`[nats] published ${event.event} → ${subject}`);
  } finally {
    await nc.drain();
  }
}

function resolvePublishSubject(prefix: string, event: TaskEvent): string {
  switch (event.event) {
    case "delegation":
      return delegationSubject(prefix, event.worker);
    case "ack":
      return taskSubject(prefix, event.task_id, "ack");
    case "progress":
      return taskSubject(prefix, event.task_id, "progress");
    case "ship":
      return taskSubject(prefix, event.task_id, "ship");
    case "block":
      return taskSubject(prefix, event.task_id, "block");
  }
}

// ── Subscriber ────────────────────────────────────────────────────────────────

/** Handler called for each received TaskEvent. */
export type TaskEventHandler = (event: TaskEvent, subject: string) => Promise<void> | void;

export interface SubscribeOptions {
  /** Which subjects to subscribe to. Defaults to ["delegation"] subject for the given workerId. */
  mode: "worker" | "pm";
  /** Required when mode=worker. */
  worker_id?: string;
  /** Additional filters: only handle these event types (undefined = all). */
  event_filter?: TaskEventType[];
  /** Queue group name for load-balanced multi-instance workers. */
  queue_group?: string;
}

/**
 * Open a long-running subscriber for task events.
 *
 * Returns a cleanup function — call it to drain the connection and exit.
 */
export async function subscribeTaskEvents(
  cfg: NatsConfig,
  opts: SubscribeOptions,
  handler: TaskEventHandler
): Promise<() => Promise<void>> {
  const nc = await openNatsConnection(cfg);
  const prefix = cfg.subject_prefix;

  const subjects: string[] =
    opts.mode === "worker"
      ? [delegationSubject(prefix, opts.worker_id!)]
      : [allTaskEventsSubject(prefix)];

  const subs: Subscription[] = subjects.map((subject) => {
    const subOpts = opts.queue_group ? { queue: opts.queue_group } : {};
    return nc.subscribe(subject, subOpts);
  });

  // Drive subscriptions concurrently.
  const drainPromises = subs.map((sub) => driveSubscription(sub, opts.event_filter, handler));

  log.info(`[nats] subscribed to: ${subjects.join(", ")}`);

  const cleanup = async (): Promise<void> => {
    for (const sub of subs) sub.unsubscribe();
    await Promise.all(drainPromises).catch(() => {/* ignore post-unsub errors */});
    await nc.drain();
  };

  return cleanup;
}

async function driveSubscription(
  sub: Subscription,
  filter: TaskEventType[] | undefined,
  handler: TaskEventHandler
): Promise<void> {
  for await (const msg of sub) {
    let event: TaskEvent;
    try {
      event = TaskEventSchema.parse(JSON.parse(sc.decode(msg.data)));
    } catch (err) {
      log.warn(`[nats] failed to parse message on ${msg.subject}: ${err}`);
      continue;
    }

    if (filter && !filter.includes(event.event)) continue;

    try {
      await handler(event, msg.subject);
    } catch (err) {
      log.error(`[nats] handler error for ${event.event}/${event.task_id}: ${err}`);
    }
  }
}

// ── Re-exports for convenience ────────────────────────────────────────────────

export { NatsConfig };
