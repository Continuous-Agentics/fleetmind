/**
 * Model-provider helpers.
 *
 * FleetMind is provider-neutral: an agent's `model` is a "provider/model"
 * string (e.g. "anthropic/claude-sonnet-4-6", "openai/gpt-4o",
 * "google/gemini-2.0-flash"). OpenClaw makes the actual model call; FleetMind's
 * only job is to make the right provider API key available at runtime.
 *
 * These helpers derive the provider from a model string and the conventional
 * env-var / Secrets Manager key names from a provider. The conventions
 * generalize the original Anthropic-only ones, and are byte-for-byte compatible
 * for the "anthropic" case (ANTHROPIC_API_KEY, secret key ANTHROPIC_API_KEY) so
 * the existing runtime contract is preserved.
 */

/** Normalize an identifier into an env-var-safe UPPER_SNAKE token. */
function envToken(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * The provider segment of a "provider/model" string, lowercased.
 * Returns null when the string is empty or has no leading "provider/" segment
 * (i.e. nothing before the first "/"), since a provider can't be inferred.
 *
 * Examples:
 *   "anthropic/claude-sonnet-4-6" → "anthropic"
 *   "openai/gpt-4o"               → "openai"
 *   "claude-sonnet-4-6"           → null   (no provider prefix)
 */
export function modelProvider(model: string | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return model.slice(0, slash).toLowerCase();
}

/**
 * The conventional API-key env var for a provider:
 *   "anthropic" → "ANTHROPIC_API_KEY"
 *   "openai"    → "OPENAI_API_KEY"
 * Also the key used inside the per-provider Secrets Manager secret.
 */
export function providerApiKeyVar(provider: string): string {
  return `${envToken(provider)}_API_KEY`;
}

/**
 * The per-agent override env var for a provider key:
 *   ("conductor", "anthropic") → "CONDUCTOR_ANTHROPIC_API_KEY"
 *   ("pm-bot",    "openai")    → "PM_BOT_OPENAI_API_KEY"
 */
export function agentProviderApiKeyVar(agentId: string, provider: string): string {
  return `${envToken(agentId)}_${providerApiKeyVar(provider)}`;
}

/** FleetMind's default model provider — used when an agent's model has no
 *  provider prefix and it lists no explicit api_keys, so every agent still
 *  resolves at least one provider (preserves the original Anthropic default). */
export const DEFAULT_MODEL_PROVIDER = "anthropic";

/**
 * The set of providers an agent needs API keys for: the provider of its
 * resolved model, plus any provider it lists an explicit `api_keys` entry for.
 * Falls back to [DEFAULT_MODEL_PROVIDER] when nothing can be derived. Order:
 * model provider first, then api_keys insertion order.
 */
export function providersForAgent(opts: {
  model?: string;
  apiKeys?: Record<string, string>;
  defaultModel?: string;
}): string[] {
  const set = new Set<string>();
  const fromModel = modelProvider(opts.model ?? opts.defaultModel);
  if (fromModel) set.add(fromModel);
  for (const p of Object.keys(opts.apiKeys ?? {})) set.add(p.toLowerCase());
  if (set.size === 0) set.add(DEFAULT_MODEL_PROVIDER);
  return [...set];
}
