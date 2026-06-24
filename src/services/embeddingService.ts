import { getChatClient, getChatModel, getEmbeddingChain } from "../lib/llmClient";

/**
 * Required embedding dimensionality. Matches the `vector(1536)` column
 * type on `symbols.embedding` in `prisma/schema.prisma`. Vectors of any
 * other length are rejected by Postgres on insert with a cryptic error,
 * so we guard here and skip the write instead.
 *
 * If you swap to an embedding model with a different output dim,
 * update this constant AND the schema column in the same PR.
 */
export const EMBEDDING_DIM = 1536;

/**
 * Module-level circuit breaker. Once every provider in the embedding chain
 * has failed in a single session, subsequent calls short-circuit to []
 * without touching the network. Prevents log spam from the indexing service
 * (which retries every symbol on a schedule).
 *
 * Reset only by process restart — good enough for dev. Production rarely
 * hits all-providers-fail; if it does, an operator restart picks up new
 * config.
 */
let embeddingCircuitOpen = false;

export class EmbeddingService {
  /**
   * Generates a short semantic docstring/summary for a code symbol via the
   * configured chat model. Returns "" if no LLM client or chat model is
   * configured (callers treat empty summaries as a no-op).
   */
  public static async generateSummary(
    name: string,
    filePath: string,
    signature: string,
    sourceCode: string,
  ): Promise<string> {
    const client = getChatClient();
    const model = getChatModel();
    if (!client || !model) return "";

    const prompt = `Given this function/class, write a single concise paragraph (2-4 sentences) in plain English
describing what it does, what it accepts as input, what it returns, and any important
side effects or error conditions. Do not describe implementation details unless they
are the only way to convey the function's behaviour.

Function/Class name: ${name}
File: ${filePath}
Signature: ${signature}
Source:
${sourceCode}`;

    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      });
      return response.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      console.error(`Failed to generate summary for ${name}:`, e);
      return "";
    }
  }

  /**
   * Generates a vector embedding for a piece of text (usually the summary)
   * via the configured embedding model. Tries each provider in the chain
   * (primary then fallback) until one succeeds.
   *
   * Returns [] when:
   *   - no text provided
   *   - the circuit breaker is open (every provider already failed this session)
   *   - no provider is configured
   *   - every provider in the chain threw
   *
   * When all providers fail, the circuit breaker trips and a single
   * console.error is emitted with a friendly remediation hint — preventing
   * the indexing service from spamming the dev log every few seconds.
   */
  public static async generateEmbedding(text: string): Promise<number[]> {
    if (!text) return [];
    if (embeddingCircuitOpen) return [];

    const chain = getEmbeddingChain();
    if (chain.length === 0) return [];

    for (const { client, model, name } of chain) {
      try {
        const response = await client.embeddings.create({ model, input: text });
        const vec = response.data?.[0]?.embedding || [];
        if (vec.length === 0) {
          // Empty-but-no-throw response is unusual but not fatal — try next.
          console.warn(`[embedding] provider ${name} returned empty vector, trying next`);
          continue;
        }
        if (vec.length !== EMBEDDING_DIM) {
          // Wrong-shape vector — persisting it would either fail at the
          // DB cast or, worse, succeed with corrupted similarity scores.
          // Skip + warn so the summary still lands.
          console.warn(
            `[embedding] provider ${name} returned ${vec.length} dimensions, ` +
              `schema requires ${EMBEDDING_DIM}. Summary saved; semantic search ` +
              `disabled for this symbol. Swap the model or update EMBEDDING_DIM.`,
          );
          return [];
        }
        return vec;
      } catch (err: any) {
        console.warn(`[embedding] provider ${name} failed: ${(err?.message || String(err)).slice(0, 120)}`);
        continue;
      }
    }

    // Every provider failed — trip the breaker and log once.
    if (!embeddingCircuitOpen) {
      embeddingCircuitOpen = true;
      console.error(
        "[embedding] All providers failed. Further embedding calls will be skipped this session. " +
          "Reinstall Ollama (`curl -fsSL https://ollama.com/install.sh | sh` && `ollama pull mxbai-embed-large`) " +
          "or configure a cloud embedding fallback in LLM Settings, then restart the dev server.",
      );
    }
    return [];
  }

  /**
   * Test hook + recovery escape hatch: manually reset the circuit breaker.
   * Not currently called in production — the breaker auto-resets on
   * process restart. Exposed in case an admin script wants to retry
   * after a config fix without bouncing the server.
   */
  public static resetCircuitBreaker(): void {
    embeddingCircuitOpen = false;
  }

  /** Test hook for inspecting breaker state. */
  public static isCircuitOpen(): boolean {
    return embeddingCircuitOpen;
  }

  /**
   * Cosine similarity between two equal-length vectors. Returns 0 for
   * length-mismatched inputs (e.g., when the embedding model was swapped
   * after indexing — prevents silently wrong-but-nonzero scores).
   */
  public static cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
