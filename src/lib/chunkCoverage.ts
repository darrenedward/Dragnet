export const TERMINAL_CHUNK_STATUSES = ["completed", "failed", "skipped"] as const;

export interface ChunkCoverage {
  chunksTotal: number;
  chunksCompleted: number;
  chunksFailed: number;
  chunksSkipped: number;
  chunksIncomplete: number;
}

export function isTerminalChunkStatus(status: string | null | undefined): boolean {
  return (TERMINAL_CHUNK_STATUSES as readonly string[]).includes(status ?? "");
}

export function getChunkCoverage(chunks: Array<{ status: string | null | undefined }>): ChunkCoverage {
  const chunksTotal = chunks.length;
  const chunksCompleted = chunks.filter((chunk) => chunk.status === "completed").length;
  const chunksFailed = chunks.filter((chunk) => chunk.status === "failed").length;
  const chunksSkipped = chunks.filter((chunk) => chunk.status === "skipped").length;
  return {
    chunksTotal,
    chunksCompleted,
    chunksFailed,
    chunksSkipped,
    chunksIncomplete: chunks.filter((chunk) => !isTerminalChunkStatus(chunk.status)).length,
  };
}
