/**
 * Channel accessors.
 *
 * Channels are a discriminated union (see config/schema.ts). These helpers
 * narrow an agent's channel list to a specific provider so callers don't repeat
 * the `find(c => c.provider === …)` dance. Slack is the only provider today;
 * add helpers here as new providers land.
 */

import type { AgentConfig, SlackChannel } from "../config/schema.js";

/** The agent's Slack channel binding, if it has one. */
export function slackChannel(agent: AgentConfig): SlackChannel | undefined {
  return agent.channels.find((c): c is SlackChannel => c.provider === "slack");
}
