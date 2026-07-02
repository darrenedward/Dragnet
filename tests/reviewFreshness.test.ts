import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  reviewRunFindFirst: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    reviewRun: {
      findFirst: prismaMocks.reviewRunFindFirst,
    },
  },
}));

import {
  assertReviewFreshness,
  computeDiffHash,
  computeReviewConfigHash,
  parseIterationLogs,
  shortHash,
} from "../src/lib/reviewFreshness";

beforeEach(() => {
  prismaMocks.reviewRunFindFirst.mockReset();
});

describe("reviewFreshness", () => {
  describe("computeDiffHash", () => {
    it("returns empty string when no files have diffs", () => {
      expect(computeDiffHash([])).toBe("");
      expect(computeDiffHash([{ filename: "a.ts", diff: "" }])).toBe("");
      expect(computeDiffHash([{ filename: "a.ts", diff: null }])).toBe("");
      expect(computeDiffHash([{ filename: "a.ts", diff: "   " }])).toBe("");
    });

    it("produces identical hashes for identical input", () => {
      const files = [
        { filename: "a.ts", diff: "+line1" },
        { filename: "b.ts", diff: "-line2\n+line3" },
      ];
      expect(computeDiffHash(files)).toBe(computeDiffHash(files));
    });

    it("is stable across input reordering (sorts by filename)", () => {
      const ordered = [
        { filename: "a.ts", diff: "+x" },
        { filename: "b.ts", diff: "+y" },
        { filename: "c.ts", diff: "+z" },
      ];
      const reversed = [...ordered].reverse();
      const shuffled = [ordered[1], ordered[2], ordered[0]];
      expect(computeDiffHash(ordered)).toBe(computeDiffHash(reversed));
      expect(computeDiffHash(ordered)).toBe(computeDiffHash(shuffled));
    });

    it("changes when diff content changes", () => {
      const a = [{ filename: "a.ts", diff: "+original" }];
      const b = [{ filename: "a.ts", diff: "+modified" }];
      expect(computeDiffHash(a)).not.toBe(computeDiffHash(b));
    });

    it("produces a 16-char hex string", () => {
      const hash = computeDiffHash([{ filename: "a.ts", diff: "+x" }]);
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe("computeReviewConfigHash", () => {
    it("is deterministic for the same chain + prompt", () => {
      const chain = [{ name: "primary", model: "gpt-4o" }];
      const promptHash = shortHash("system-prompt-v1");
      expect(computeReviewConfigHash(chain, promptHash))
        .toBe(computeReviewConfigHash(chain, promptHash));
    });

    it("changes when model changes", () => {
      const promptHash = shortHash("prompt");
      const a = computeReviewConfigHash([{ name: "p", model: "gpt-4o" }], promptHash);
      const b = computeReviewConfigHash([{ name: "p", model: "claude-sonnet-4-6" }], promptHash);
      expect(a).not.toBe(b);
    });

    it("changes when prompt hash changes", () => {
      const chain = [{ name: "p", model: "gpt-4o" }];
      const a = computeReviewConfigHash(chain, shortHash("prompt-a"));
      const b = computeReviewConfigHash(chain, shortHash("prompt-b"));
      expect(a).not.toBe(b);
    });

    it("incorporates fallback model when present", () => {
      const promptHash = shortHash("prompt");
      const single = computeReviewConfigHash([{ name: "p", model: "gpt-4o" }], promptHash);
      const withFallback = computeReviewConfigHash(
        [{ name: "p", model: "gpt-4o" }, { name: "fb", model: "claude" }],
        promptHash,
      );
      expect(single).not.toBe(withFallback);
    });

    it("changes when provider endpoint changes", () => {
      const promptHash = shortHash("prompt");
      const a = computeReviewConfigHash(
        [{ name: "primary", endpoint: "https://api.one.example/v1", model: "gpt-4o" }],
        promptHash,
      );
      const b = computeReviewConfigHash(
        [{ name: "primary", endpoint: "https://api.two.example/v1", model: "gpt-4o" }],
        promptHash,
      );
      expect(a).not.toBe(b);
    });

    it("changes when provider name changes", () => {
      const promptHash = shortHash("prompt");
      const a = computeReviewConfigHash(
        [{ name: "primary-a", endpoint: "https://api.example/v1", model: "gpt-4o" }],
        promptHash,
      );
      const b = computeReviewConfigHash(
        [{ name: "primary-b", endpoint: "https://api.example/v1", model: "gpt-4o" }],
        promptHash,
      );
      expect(a).not.toBe(b);
    });

    it("changes when the model iteration cap changes", () => {
      const promptHash = shortHash("prompt");
      const a = computeReviewConfigHash([{ name: "p", model: "gpt-4o", maxIterations: 8 }], promptHash);
      const b = computeReviewConfigHash([{ name: "p", model: "gpt-4o", maxIterations: 16 }], promptHash);
      expect(a).not.toBe(b);
    });

    it("changes when review limits change", () => {
      const promptHash = shortHash("prompt");
      const chain = [{ name: "p", model: "gpt-4o" }];
      const limits = {
        chunkLineCap: 600,
        minUsefulChunkLines: 100,
        normalMaxLines: 800,
        normalMaxCodeFiles: 40,
        oversizedLines: 3000,
        oversizedCodeFiles: 100,
        maxFilesPerReview: 0,
      };
      const a = computeReviewConfigHash(chain, promptHash, limits);
      const b = computeReviewConfigHash(chain, promptHash, { ...limits, chunkLineCap: 1200 });
      expect(a).not.toBe(b);
    });
  });

  describe("shortHash", () => {
    it("returns 16-char hex", () => {
      expect(shortHash("anything")).toMatch(/^[a-f0-9]{16}$/);
    });

    it("is deterministic", () => {
      expect(shortHash("x")).toBe(shortHash("x"));
    });

    it("differs across inputs", () => {
      expect(shortHash("a")).not.toBe(shortHash("b"));
    });
  });

  describe("assertReviewFreshness", () => {
    const pr = { id: "pr-1", commitHash: "commit-current" };
    const matchingRun = {
      id: "run-1",
      commitHash: "commit-current",
      diffHash: "diff-current",
      reviewConfigHash: "config-current",
      rating: 8,
      reliability: null,
    };

    it("reuses a matching completed run with a concrete rating", async () => {
      prismaMocks.reviewRunFindFirst.mockResolvedValue(matchingRun);

      await expect(
        assertReviewFreshness(pr, "diff-current", "config-current"),
      ).resolves.toEqual({ ok: true, runId: "run-1", rating: 8 });
    });

    it("does not reuse a matching completed run with null rating", async () => {
      prismaMocks.reviewRunFindFirst.mockResolvedValue({ ...matchingRun, rating: null });

      const result = await assertReviewFreshness(pr, "diff-current", "config-current");

      expect(result.ok).toBe(false);
      if (!("kind" in result)) throw new Error("expected cache miss for null rating");
      expect(result.kind).toBe("STALE_RUN");
      expect(result.message).toContain("rating=null");
    });

    it("does not reuse a matching completed run with partial reliability", async () => {
      prismaMocks.reviewRunFindFirst.mockResolvedValue({ ...matchingRun, reliability: "partial" });

      const result = await assertReviewFreshness(pr, "diff-current", "config-current");

      expect(result.ok).toBe(false);
      if (!("kind" in result)) throw new Error("expected cache miss for partial reliability");
      expect(result.kind).toBe("STALE_RUN");
      expect(result.message).toContain("reliability=partial");
    });
  });

  describe("parseIterationLogs", () => {
    it("resets displayed progress when a fallback provider starts its own budget", () => {
      const parsed = parseIterationLogs([
        { message: "Iteration 1/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 2/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 3/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 4/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Loop exhausted — no submitReview after 4 iterations", reviewChunkId: "chunk-a" },
        { message: "Iteration 1/16 — Minimax", reviewChunkId: "chunk-a" },
        { message: "Iteration 2/16 — Minimax", reviewChunkId: "chunk-a" },
      ]);

      expect(parsed["chunk-a"]).toEqual({ current: 2, max: 16, provider: "Minimax" });
    });

    it("tracks each chunk independently", () => {
      const parsed = parseIterationLogs([
        { message: "Iteration 4/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 1/16 — Minimax", reviewChunkId: "chunk-a" },
        { message: "Iteration 3/4 — NVIDIA", reviewChunkId: "chunk-b" },
      ]);

      expect(parsed["chunk-a"]).toEqual({ current: 1, max: 16, provider: "Minimax" });
      expect(parsed["chunk-b"]).toEqual({ current: 3, max: 4, provider: "NVIDIA" });
    });
  });
});
