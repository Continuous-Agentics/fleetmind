import * as core from "@continuous-agentics/delegation-core";
import type { TaskEvent, NatsTaskEventsConfig } from "@continuous-agentics/delegation-core";
import { credsAuthenticator } from "nats";
import { readFileSync } from "node:fs";
import type { DelegationFleetConfig } from "../../config/schema.js";
import { log } from "../../utils/log.js";

// Published core 0.1.2 exposes NATS and TaskEvent, but not the optional SQS
// factory. Keep this producer boundary limited to the methods it actually uses.
export type TaskEventsConfig =
  | ({ provider: "nats" } & NatsTaskEventsConfig)
  | (NonNullable<DelegationFleetConfig["taskEventTransport"]> & { region?: string });
export type TaskEventPublisher = Pick<core.NatsTaskEvents, "publish" | "close">;
export type TaskEventFactory = (config: TaskEventsConfig) => TaskEventPublisher;
const compatibleCore: Pick<typeof core, "NatsTaskEvents"> & {
  createTaskEvents?: TaskEventFactory;
} = core;

export function taskEventsConfig(delegation: DelegationFleetConfig): TaskEventsConfig {
  if (delegation.taskEventTransport) return {
    ...delegation.taskEventTransport,
    region: delegation.taskEventTransport.region ?? delegation.aws_region,
  };
  const nats = delegation.nats;
  if (!nats?.servers?.length) throw new Error("delegation.nats.servers is empty");
  return {
    provider: "nats", servers: nats.servers, subjectPrefix: nats.subject_prefix,
    timeout: nats.connect_timeout_ms, maxReconnectAttempts: nats.max_reconnect,
    inboxPrefix: nats.inbox_prefix,
    ...(nats.creds_file ? { authenticator: credsAuthenticator(readFileSync(nats.creds_file)) } : {}),
  };
}

/** Keep the existing best-effort notification after the authoritative task write.
 * This does not close the pre-existing task-write/publish crash window.
 */
export async function publishConfiguredTaskEvent(
  delegation: DelegationFleetConfig | undefined,
  event: TaskEvent,
  factory: TaskEventFactory | undefined = compatibleCore.createTaskEvents,
): Promise<void> {
  if (!delegation?.enabled) return;
  // A published core pin cannot be advanced until the frozen adapter is released.
  // Fail explicitly before attempting a notification with an older artifact.
  if (typeof factory !== "function" && delegation.taskEventTransport?.provider === "sqs") throw new Error("Task event factory unavailable: release and pin the SQS-capable delegation-core candidate before using this FleetMind build.");
  let transport: TaskEventPublisher | undefined;
  try {
    const config = taskEventsConfig(delegation);
    if (typeof factory === "function") {
      transport = factory(config);
    } else if (config.provider === "nats") {
      transport = new core.NatsTaskEvents(config);
    } else {
      throw new Error("Task event factory unavailable for SQS");
    }
    await transport.publish(event);
    log.info(`[task-events] published ${event.event}/${event.task_id}`);
  } catch (error) {
    log.warn(`[task-events] publish failed for ${event.event}/${event.task_id}: ${error}`);
  } finally {
    try { await transport?.close(); }
    catch (error) { log.warn(`[task-events] close failed: ${error}`); }
  }
}
