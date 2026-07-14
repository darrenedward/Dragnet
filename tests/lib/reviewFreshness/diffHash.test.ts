import { describe, it, expect } from "vitest";

import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
} from "../../../src/lib/reviewFreshness";

describe("reviewFreshness > diffHash", () => {
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

    it("produces identical hashes for identical diff content even when commit hints differ (issue #33)", () => {
      // #33 inverts #13: a no-op rebase (new commit hash, byte-identical
      // diff text — e.g. cherry-pick to a new HEAD, or a force-push that
      // leaves the diff unchanged) MUST produce the same diffHash so the
      // cached review is reused instead of triggering a wasted rescan.
      const files = [{ filename: "src/foo.ts", diff: "@@ -1 +1 @@\n-x\n+y" }];
      const hashA = computeDiffHash(files, "aaa111");
      const hashB = computeDiffHash(files, "bbb222");
      const hashC = computeDiffHash(files, "ccc333");
      expect(hashA).toBe(hashB);
      expect(hashA).toBe(hashC);
      expect(hashA).toMatch(/^[a-f0-9]{16}$/);
    });

    it("produces identical hashes for identical diff content with the same commit hint (regression guard)", () => {
      const files = [
        { filename: "src/a.ts", diff: "+added" },
        { filename: "src/b.ts", diff: "-removed\n+added" },
      ];
      expect(computeDiffHash(files, "abc123")).toBe(computeDiffHash(files, "abc123"));
      expect(computeDiffHash(files)).toBe(computeDiffHash(files, "abc123"));
    });

    it("produces different hashes when diff content changes (regression guard)", () => {
      const a = [{ filename: "src/foo.ts", diff: "@@ -1 +1 @@\n-x\n+y" }];
      const b = [{ filename: "src/foo.ts", diff: "@@ -1 +1 @@\n-x\n+z" }];
      expect(computeDiffHash(a, "abc123")).not.toBe(computeDiffHash(b, "abc123"));
      expect(computeDiffHash(a)).not.toBe(computeDiffHash(b));
    });

    it("ignores the commitHint parameter entirely (back-compat with existing callers)", () => {
      // All 5 production callers pass `pr.commitHash` as the second
      // argument. The argument is now intentionally unused — verify
      // both the empty string and arbitrary hashes produce the same
      // content-only hash as the no-arg call.
      const files = [{ filename: "a.ts", diff: "+x" }];
      const base = computeDiffHash(files);
      expect(computeDiffHash(files, "")).toBe(base);
      expect(computeDiffHash(files, "any-commit-hash")).toBe(base);
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
});