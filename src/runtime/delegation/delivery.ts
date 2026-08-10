/**
 * Channel delivery adapters for delegation lifecycle events.
 *
 * Lifecycle state and NATS events use DeliveryContext. This module contains the
 * provider-specific conversion required to route an OpenClaw wake into an
 * existing conversation. It intentionally knows nothing about DDB or NATS.
 */

import type { DeliveryContext } from "./types.js";

export interface SlackThreadTarget {
  conversationId: string;
  threadId: string;
}

/**
 * Read the pre-plugin Slack permalink stored in v0.2 task records.
 *
 * The resulting target is deliberately not a DeliveryContext: legacy records
 * do not contain an OpenClaw account id. Callers use it only as a fallback
 * while new records supply `delivery_context`.
 */
export function legacySlackThreadTarget(url: string): SlackThreadTarget | undefined {
  const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{7,})/);
  if (!match) return undefined;
  const compactTimestamp = match[2]!;
  return {
    conversationId: match[1]!,
    threadId: `${compactTimestamp.slice(0, -6)}.${compactTimestamp.slice(-6)}`,
  };
}

/** Return a Slack thread target only when a context can be routed as Slack. */
export function slackThreadTarget(context: DeliveryContext | undefined): SlackThreadTarget | undefined {
  if (context?.provider !== "slack" || !context.threadId) return undefined;
  return { conversationId: context.conversationId, threadId: context.threadId };
}

/**
 * Whether the legacy Slack adapter may handle this delivery.
 *
 * Legacy records have no context and retain their existing Slack behavior.
 * Once a context exists, its provider is authoritative: a Discord task must
 * never cause a Slack acknowledgement merely because the worker also has a
 * Slack home channel configured.
 */
export function usesSlackDeliveryAdapter(context: DeliveryContext | undefined): boolean {
  return context === undefined || context.provider === "slack";
}

/**
 * Use legacy Slack fields only for records that predate DeliveryContext.
 *
 * A present non-Slack context is authoritative: falling through to a stale
 * Slack permalink would deliver a Discord (or future-provider) task to the
 * wrong conversation.
 */
export function slackThreadTargetWithLegacyFallback(
  context: DeliveryContext | undefined,
  legacyThreadUrl: string,
): SlackThreadTarget | undefined {
  return context ? slackThreadTarget(context) : legacySlackThreadTarget(legacyThreadUrl);
}

/**
 * Build the known OpenClaw Slack thread session key. Other channel adapters
 * return undefined until their session-key contract is explicitly verified.
 */
export function sessionKeyForDeliveryContext(
  agentId: string,
  context: DeliveryContext | undefined,
): string | undefined {
  const target = slackThreadTarget(context);
  if (!target) return undefined;
  return `agent:${agentId}:slack:channel:${target.conversationId.toLowerCase()}:thread:${target.threadId}`;
}

/** Build a session key for a legacy v0.2 Slack permalink during migration. */
export function sessionKeyForLegacySlackThread(agentId: string, url: string): string | undefined {
  const target = legacySlackThreadTarget(url);
  if (!target) return undefined;
  return `agent:${agentId}:slack:channel:${target.conversationId.toLowerCase()}:thread:${target.threadId}`;
}

/** Match `slackThreadTargetWithLegacyFallback` when selecting a wake session. */
export function sessionKeyForDeliveryWithLegacyFallback(
  agentId: string,
  context: DeliveryContext | undefined,
  legacyThreadUrl: string,
): string | undefined {
  return context
    ? sessionKeyForDeliveryContext(agentId, context)
    : sessionKeyForLegacySlackThread(agentId, legacyThreadUrl);
}
