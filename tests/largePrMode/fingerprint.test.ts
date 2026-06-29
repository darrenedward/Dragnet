import { describe, expect, it } from "vitest";
import { buildFindingFingerprint } from "../../src/services/largePrReview";

describe("buildFindingFingerprint", () => {
  it("is deterministic — same inputs produce the same hash", () => {
    const a = buildFindingFingerprint({
      symbolId: "sym-123",
      filePath: "src/users.ts",
      category: "SQL_INJECTION",
    });
    const b = buildFindingFingerprint({
      symbolId: "sym-123",
      filePath: "src/users.ts",
      category: "SQL_INJECTION",
    });
    expect(a).toEqual(b);
  });

  it("anchors on symbolId, ignoring filePath (re-exports/aliases group)", () => {
    // Two findings in different files but anchored to the same symbol ID
    // (e.g., a function re-exported from a barrel) should collapse to one.
    const a = buildFindingFingerprint({
      symbolId: "sym-shared",
      filePath: "src/old.ts",
      category: "BUG",
    });
    const b = buildFindingFingerprint({
      symbolId: "sym-shared",
      filePath: "src/new.ts",
      category: "BUG",
    });
    expect(a).toEqual(b);
  });

  it("produces different hashes for the same category on different symbols", () => {
    // Two distinct functions in the same file must not collide.
    const fn1 = buildFindingFingerprint({
      symbolId: "sym-1",
      filePath: "src/users.ts",
      category: "BUG",
    });
    const fn2 = buildFindingFingerprint({
      symbolId: "sym-2",
      filePath: "src/users.ts",
      category: "BUG",
    });
    expect(fn1).not.toEqual(fn2);
  });

  it("produces different hashes for different categories on the same symbol", () => {
    const injection = buildFindingFingerprint({
      symbolId: "sym-1",
      filePath: "src/api.ts",
      category: "SQL_INJECTION",
    });
    const ratelimit = buildFindingFingerprint({
      symbolId: "sym-1",
      filePath: "src/api.ts",
      category: "RATE_LIMIT",
    });
    expect(injection).not.toEqual(ratelimit);
  });

  it("falls back to filePath+category when symbolId is missing", () => {
    // Config files, root scripts, anything outside an indexed symbol.
    const a = buildFindingFingerprint({
      symbolId: null,
      filePath: "config/database.yml",
      category: "MISCONFIG",
    });
    const b = buildFindingFingerprint({
      filePath: "config/database.yml",
      category: "MISCONFIG",
    });
    expect(a).toEqual(b);
  });

  it("fallback path distinguishes different files", () => {
    const a = buildFindingFingerprint({
      filePath: "config/dev.yml",
      category: "MISCONFIG",
    });
    const b = buildFindingFingerprint({
      filePath: "config/prod.yml",
      category: "MISCONFIG",
    });
    expect(a).not.toEqual(b);
  });

  it("symbol-anchored and fallback paths do not collide for the same file+category", () => {
    // If a finding moves from "no symbol resolved" to "symbol resolved" across
    // runs (e.g., after a re-index), they should NOT group — the symbol anchor
    // is a stronger identity signal and the prior fallback fingerprint was a
    // placeholder. PR2's reconcile logic handles the migration explicitly.
    const symbolAnchored = buildFindingFingerprint({
      symbolId: "sym-1",
      filePath: "src/users.ts",
      category: "BUG",
    });
    const fallback = buildFindingFingerprint({
      symbolId: null,
      filePath: "src/users.ts",
      category: "BUG",
    });
    expect(symbolAnchored).not.toEqual(fallback);
  });

  it("returns a 16-char lowercase hex string", () => {
    const fp = buildFindingFingerprint({
      symbolId: "sym-1",
      filePath: "x.ts",
      category: "X",
    });
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });
});
