/**
 * FleetMind NATS transport.
 *
 * Provides a thin publisher and subscriber layer over the NATS.io client
 * for inter-agent task delegation events.
 *
 * Subject naming convention (all relative to `subject_prefix`, default "fleetmind"):
 *
 *   {prefix}.delegation.{worker_id}        – PM → worker: new task delegation
 *   {prefix}.task.{task_id}.ack            – worker → PM: task acknowledged
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
import { NatsConfig } from "../config/schema.js";
import { log } from "../utils/log.js";

// ── Event schema ─────────────────────────────────────────────────────────────

/** Union of all task event types published over NATS. */
export type TaskEventType =
  | "delegation"
  | "ack"
  | "progress"
  | "ship"
  | "block";

/** Core envelope published for every task event. */
export interface TaskEvent {
  /** Schema version — bump when the payload shape changes. */
  v: "1.0";
  /** Event type. */
  event: TaskEventType;
  /** 8-char hex task ID. */
  task_id: string;
  /**
   * Project slug. Present in all events when known; optional in worker→PM
   * events (ack/progress/ship/block) where the worker may not have it.
   */
  project?: string;
  /** Worker agent ID. */
  worker: string;
  /**
   * PM bot agent ID. Present in delegation events; optional in worker→PM
   * events (ack/progress/ship/block) since the PM already knows the task.
   */
  delegated_by?: string;
  /** ISO 8601 timestamp of this event. */
  at: string;
  /**
   * Full definition of done — included in delegation events so workers
   * do not need a DDB round-trip for basic display.
   */
  definition_of_done?: string;
  /**
   * Free-text description of the feature / work context.
   * Included in delegation events so workers can open an informed Slack
   * thread with the requestor without a DDB round-trip.
   */
  description?: string;
  /**
   * Slack user ID (U…) of the human who requested this feature.
   * Workers use this to open a Slack thread directly with the requestor
   * on delegation receipt.
   */
  requestor?: string;
  /**
   * External tracker link (Linear, Jira, etc.) — included in delegations
   * so workers can update the tracker without a DDB lookup.
   */
  tracker_link?: string;
  /**
   * Delegation thread URL — included so workers know where to reply.
   */
  delegation_thread?: string;
  /**
   * Delegation envelope Slack message TS — needed for `:eyes:` reactions
   * and threaded replies when Slack is also in use.
   */
  delegation_envelope_ts?: string;
  /**
   * Optional free-form reason (used in block events to carry the blocker
   * summary without requiring a DDB read on the PM side).
   */
  reason?: string;
  /**
   * Progress message (used in progress events).
   * Freeform update from the worker to the PM bot mid-task.
   */
  message?: string;
}

// ── Subject helpers ───────────────────────────────────────────────────────────

export function delegationSubject(prefix: string, workerId: string): string {
  return `${prefix}.delegation.${workerId}`;
}

export function taskSubject(prefix: string, taskId: string, event: "ack" | "progress" | "ship" | "block"): string {
  return `${prefix}.task.${taskId}.${event}`;
}

/** Wildcard subject that matches all task lifecycle events. Used by the PM bot subscriber. */
export function allTaskEventsSubject(prefix: string): string {
  return `${prefix}.task.>`;
}

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
    log.info(`[nats] published ${event.event} → ${subject}`);
    // Flush to ensure delivery before closing.
    await nc.flush();
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
      event = JSON.parse(sc.decode(msg.data)) as TaskEvent;
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
