/**
 * Same-model guard for the skeptic pass (issue #72).
 *
 * The skeptic pass routes the fallback chat model's adversarial verdicts
 * back into the scan. When the fallback's `endpoint + chatModel` matches
 * the primary's, the "second opinion" is the same model reviewing its own
 * output — same blind spots, no signal. The UI warns and disables the
 * enable toggle so the user doesn't silently get useless self-review.
 *
 * Comparison contract:
 *  - Endpoint: case-insensitive, trailing slash trimmed. `https://X/v1`
 *    and `https://X/v1/` are the same upstream.
 *  - Model: case-insensitive, whitespace-trimmed. Provider catalogs are
 *    inconsistent about casing (`gpt-4o` vs `GPT-4O`), and OpenRouter
 *    treats them identically.
 *  - Empty/missing fields never match — absent config shouldn't lock the
 *    user out of enabling the pass.
 *
 * Pure so it can be unit-tested without React or filesystem state.
 */

export interface ChatPresetRef {
  endpoint: string;
  chatModel: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Returns true when primary and fallback chat presets point at the same
 * upstream endpoint+model. Empty fields on either side short-circuit to
 * false — missing config is a different problem from duplicate config.
 */
export function isSameChatModel(
  primary: ChatPresetRef | null | undefined,
  fallback: ChatPresetRef | null | undefined,
): boolean {
  if (!primary || !fallback) return false;
  const ep = normalize(primary.endpoint);
  const fm = normalize(primary.chatModel);
  if (!ep || !fm) return false;
  return ep === normalize(fallback.endpoint) && fm === normalize(fallback.chatModel);
}
