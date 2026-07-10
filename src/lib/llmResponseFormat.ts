/**
 * LLM response-format helpers extracted from reviewService.ts so the
 * skeptic re-rate module (and any future one-shot LLM caller) can reuse
 * them without importing the 2300-line reviewService (circular-dep risk).
 *
 * These are pure functions over model/endpoint strings — safe to call at
 * module load, no side effects.
 */

/**
 * Per-provider reasoning-model tuning. Reasoning models (GPT-5, Claude 4.x,
 * GLM 4.5+, Nemotron) need `reasoning_effort` and `max_completion_tokens`
 * (or `max_tokens`) instead of the universal `max_tokens` form; non-reasoning
 * providers (OpenRouter generic, Ollama, LM Studio) would 400 on
 * `reasoning_effort`.
 *
 * `maxTokens` is the caller-supplied budget for this call.
 */
export function reasoningOptions(model: string, maxTokens: number): Record<string, unknown> {
  if (/^gpt-5/i.test(model)) {
    return {
      reasoning_effort: "xhigh" as const,
      max_completion_tokens: maxTokens,
    };
  }
  if (/^claude-(sonnet|opus|haiku)-4/i.test(model)) {
    return {
      reasoning_effort: "high" as const,
      max_tokens: maxTokens,
    };
  }
  if (/^glm-(4\.[5-9]|[5-9])/i.test(model)) {
    return {
      reasoning_effort: "max" as const,
      max_tokens: maxTokens,
    };
  }
  if (/nemotron-3/i.test(model)) {
    return {
      reasoning_effort: "low" as const,
      max_tokens: maxTokens,
    };
  }
  return { max_tokens: maxTokens };
}

/**
 * Whether the endpoint's OpenAI-compatible API accepts
 * `response_format: {type: "json_object"}`. NVIDIA's hosted endpoint hangs
 * or 404s on that flag for some models, so fall back to plain JSON
 * instruction there. Defaults to true (most OpenAI-compatible APIs accept
 * the flag and it tightens parsing).
 */
export function supportsJsonResponseFormat(endpoint: string | null | undefined): boolean {
  if (!endpoint) return true;
  try {
    const host = new URL(endpoint).host;
    if (host === "integrate.api.nvidia.com") return false;
  } catch {
    // If the endpoint is not parseable, use the standard path.
  }
  return true;
}
