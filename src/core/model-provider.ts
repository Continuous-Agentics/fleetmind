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

/** FleetMind's historical default model provider. Kept as a constant for
 *  back-compat callers that still need it, but the strict providersForAgent()
 *  no longer uses it as a silent fallback. */
export const DEFAULT_MODEL_PROVIDER = "anthropic";

/**
 * The set of providers an agent needs API keys for.
 *
 * STRICT / EXPLICIT-ONLY (changed Nov 2026):
 *   - If `opts.providers` is set and non-empty, that list IS the answer.
 *   - Otherwise this function THROWS. There is no fallback to inferring the
 *     provider from a `model:` string or from an `api_keys:` map, because
 *     silent inference is exactly what produced the WRI fleet's wedged
 *     `secrets populate` (CLI wrote ANTHROPIC, terraform created MODEL).
 *     Operators must declare providers explicitly in fleet.yaml.
 *
 * Migration: every agent in fleet.yaml needs a top-level `providers: [...]`
 * list. Example:
 *   - id: ranger
 *     model: anthropic/claude-sonnet-4-6
 *     providers: [anthropic]
 */
export function providersForAgent(opts: {
  agentId?: string;
  providers?: string[];
  model?: string;
  apiKeys?: Record<string, string>;
  defaultModel?: string;
}): string[] {
  if (opts.providers && opts.providers.length > 0) {
    // Preserve declared order but lowercase + dedupe.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of opts.providers) {
      const p = String(raw).toLowerCase();
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }
  const id = opts.agentId ?? "<unknown>";
  throw new Error(
    `Agent '${id}' is missing required field \`providers: [...]\` in fleet.yaml. ` +
      `Explicit provider declaration is required — FleetMind no longer infers ` +
      `providers from \`model:\` strings or \`api_keys:\` entries. ` +
      `Add e.g. \`providers: [anthropic]\` (or [anthropic, openai] for multi-provider agents) ` +
      `to the agent block and re-run.`,
  );
}
