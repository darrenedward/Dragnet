import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export class EmbeddingService {
  /**
   * Generates a short semantic docstring/summary for a code symbol.
   */
  public static async generateSummary(
    name: string,
    filePath: string,
    signature: string,
    sourceCode: string
  ): Promise<string> {
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
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });
      return response.text?.trim() || "";
    } catch (e) {
      console.error(`Failed to generate summary for ${name}:`, e);
      return "";
    }
  }

  /**
   * Generates a vector embedding for a piece of text (usually the summary).
   */
  public static async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Use text-embedding-004 which has 768 dimensions by default.
      const response = await ai.models.embedContent({
        model: "text-embedding-004",
        contents: text,
      });
      return response.embeddings?.[0]?.values || [];
    } catch (e) {
      console.error("Failed to generate embedding:", e);
      return [];
    }
  }

  /**
   * Calculates cosine similarity between two vectors.
   */
  public static cosineSimilarity(vecA: number[], vecB: number[]): number {
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
