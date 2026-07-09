import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Cross-scan skeptic accumulator tests (issue #73).
 *
 * The accumulator is the per-`{provider_host}:{model}` outcome tracker
 * that powers the agreeable-skeptic warning in the SkepticPanel. State
 * is persisted to `<scanStateRoot>/<repoId>/skeptic-stats.json` (or the
 * legacy per-repo `.dragnet/skeptic-stats.json` when `repoId` is absent).
 *
 * Tests use the legacy path with a tmpdir repoPath + no repoId, so
 * `DRAGNET_SCAN_STATE_ROOT` doesn't need to be set.
 */

import {
  WARN_MIN_ADJUDICATED,
  WARN_REJECT_RATE,
  adjudicatedTotal,
  emptyStats,
  isAgreeableSkeptic,
  listProviderStats,
  recordSkepticOutcomes,
  rejectRate,
  resetProviderStats,
  statsFilePath,
} from "../src/lib/skepticStats";

let tmpDir: string;
const KEY = "minimax.example.com:minimax-m1";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-stats-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("skepticStats — pure helpers", () => {
  it("emptyStats returns zero counts", () => {
    expect(emptyStats()).toEqual({
      confirmed: 0,
      downgraded: 0,
      rejected: 0,
      updatedAt: 0,
    });
  });

  it("adjudicatedTotal sums confirmed + downgraded + rejected", () => {
    expect(adjudicatedTotal(undefined)).toBe(0);
    expect(
      adjudicatedTotal({ confirmed: 10, downgraded: 5, rejected: 3, updatedAt: 0 }),
    ).toBe(18);
  });

  it("adjudicatedTotal excludes skipped/error (they don't belong in the denominator)", () => {
    // Stats type doesn't track skipped/error across scans — only what
    // the model actually graded. This is by design: a model can't
    // rubber-stamp what it never saw.
    expect(
      adjudicatedTotal({ confirmed: 10, downgraded: 0, rejected: 0, updatedAt: 0 }),
    ).toBe(10);
  });

  it("rejectRate is rejected/adjudicated, 0 when nothing adjudicated", () => {
    expect(rejectRate(undefined)).toBe(0);
    expect(rejectRate({ confirmed: 10, downgraded: 5, rejected: 5, updatedAt: 0 })).toBe(
      5 / 20,
    );
    expect(rejectRate({ confirmed: 0, downgraded: 0, rejected: 0, updatedAt: 0 })).toBe(0);
  });
});

describe("skepticStats — isAgreeableSkeptic threshold", () => {
  it("returns false for undefined (no record)", () => {
    expect(isAgreeableSkeptic(undefined)).toBe(false);
  });

  it("returns false when sample size below WARN_MIN_ADJUDICATED", () => {
    // 0 rejects over WARN_MIN_ADJUDICATED - 1 findings — below sample.
    const total = WARN_MIN_ADJUDICATED - 1;
    expect(
      isAgreeableSkeptic({ confirmed: total, downgraded: 0, rejected: 0, updatedAt: 0 }),
    ).toBe(false);
  });

  it("returns false at exactly WARN_MIN_ADJUDICATED but reject rate above threshold", () => {
    // 5 rejects of 50 = 10% — well above the 2% warning threshold.
    expect(
      isAgreeableSkeptic({ confirmed: 45, downgraded: 0, rejected: 5, updatedAt: 0 }),
    ).toBe(false);
  });

  it("returns true at min sample with 0 rejects (0% < 2%)", () => {
    expect(
      isAgreeableSkeptic({
        confirmed: WARN_MIN_ADJUDICATED,
        downgraded: 0,
        rejected: 0,
        updatedAt: 0,
      }),
    ).toBe(true);
  });

  it("returns true with downgrades only (downgrades still count as agreement)", () => {
    // The model that only downgrades is still confirming the underlying
    // finding exists — it's not catching false positives. That counts
    // as agreeable for the warning.
    expect(
      isAgreeableSkeptic({
        confirmed: 0,
        downgraded: WARN_MIN_ADJUDICATED,
        rejected: 0,
        updatedAt: 0,
      }),
    ).toBe(true);
  });

  it("returns false at boundary: 1 reject of 50 = 2% is NOT below 2%", () => {
    expect(
      isAgreeableSkeptic({ confirmed: 49, downgraded: 0, rejected: 1, updatedAt: 0 }),
    ).toBe(false);
  });

  it("returns true with sub-threshold reject rate over min sample", () => {
    // 0.5 rejects per 100 = ~0.5% < 2%
    expect(
      isAgreeableSkeptic({ confirmed: 99, downgraded: 0, rejected: 1, updatedAt: 0 }),
    ).toBe(true);
  });

  it("WARN_REJECT_RATE is 0.02 (2%)", () => {
    expect(WARN_REJECT_RATE).toBe(0.02);
  });

  it("WARN_MIN_ADJUDICATED is 50", () => {
    expect(WARN_MIN_ADJUDICATED).toBe(50);
  });
});

describe("skepticStats — persistence", () => {
  it("statsFilePath uses .dragnet/skeptic-stats.json for legacy (no repoId)", () => {
    const p = statsFilePath(tmpDir);
    expect(p).toBe(path.join(tmpDir, ".dragnet", "skeptic-stats.json"));
  });

  it("readStatsFile returns empty providers on missing file", () => {
    const file = listProviderStats(tmpDir);
    expect(file.providers).toEqual({});
  });

  it("readStatsFile returns empty providers on corrupt JSON", () => {
    const statsPath = statsFilePath(tmpDir);
    fs.mkdirSync(path.dirname(statsPath), { recursive: true });
    fs.writeFileSync(statsPath, "{not valid json", { mode: 0o600 });
    const file = listProviderStats(tmpDir);
    expect(file.providers).toEqual({});
  });

  it("recordSkepticOutcomes creates a new record on first write", () => {
    recordSkepticOutcomes(tmpDir, KEY, { confirmed: 5, downgraded: 2, rejected: 1 });
    const file = listProviderStats(tmpDir);
    expect(file.providers[KEY]).toEqual({
      confirmed: 5,
      downgraded: 2,
      rejected: 1,
      updatedAt: expect.any(Number),
    });
  });

  it("recordSkepticOutcomes accumulates across writes (cross-scan)", () => {
    recordSkepticOutcomes(tmpDir, KEY, { confirmed: 5, downgraded: 2, rejected: 1 });
    recordSkepticOutcomes(tmpDir, KEY, { confirmed: 3, downgraded: 0, rejected: 4 });
    recordSkepticOutcomes(tmpDir, KEY, { confirmed: 0, downgraded: 1, rejected: 0 });
    const stats = listProviderStats(tmpDir).providers[KEY];
    expect(stats?.confirmed).toBe(8);
    expect(stats?.downgraded).toBe(3);
    expect(stats?.rejected).toBe(5);
  });

  it("recordSkepticOutcomes persists presetName when provided", () => {
    recordSkepticOutcomes(tmpDir, KEY, { confirmed: 1, downgraded: 0, rejected: 0 }, undefined, "Minimax");
    const stats = listProviderStats(tmpDir).providers[KEY];
    expect(stats?.presetName).toBe("Minimax");
  });

  it("recordSkepticOutcomes is a no-op when no repoPath/repoId", () => {
    recordSkepticOutcomes(null, KEY, { confirmed: 1, downgraded: 0, rejected: 0 });
    recordSkepticOutcomes(undefined, KEY, { confirmed: 1, downgraded: 0, rejected: 0 });
    // Nothing to assert other than "didn't throw" — no disk write happened.
    expect(true).toBe(true);
  });

  it("recordSkepticOutcomes ignores empty providerKey", () => {
    recordSkepticOutcomes(tmpDir, "", { confirmed: 1, downgraded: 0, rejected: 0 });
    expect(listProviderStats(tmpDir).providers).toEqual({});
  });

  it("listProviderStats returns empty when no repoPath", () => {
    expect(listProviderStats(null).providers).toEqual({});
    expect(listProviderStats(undefined).providers).toEqual({});
  });

  it("resetProviderStats with key deletes just that key", () => {
    recordSkepticOutcomes(tmpDir, KEY, { confirmed: 1, downgraded: 0, rejected: 0 });
    recordSkepticOutcomes(tmpDir, "other.example.com:model-x", {
      confirmed: 2,
      downgraded: 0,
      rejected: 0,
    });
    resetProviderStats(tmpDir, KEY);
    const file = listProviderStats(tmpDir);
    expect(file.providers[KEY]).toBeUndefined();
    expect(file.providers["other.example.com:model-x"]).toBeDefined();
  });

  it("resetProviderStats without key clears the whole file", () => {
    recordSkepticOutcomes(tmpDir, KEY, { confirmed: 1, downgraded: 0, rejected: 0 });
    recordSkepticOutcomes(tmpDir, "other.example.com:model-x", {
      confirmed: 2,
      downgraded: 0,
      rejected: 0,
    });
    resetProviderStats(tmpDir);
    expect(listProviderStats(tmpDir).providers).toEqual({});
  });
});

describe("skepticStats — accumulator reaches agreeable threshold", () => {
  it("accumulates enough scans to fire the warning", () => {
    // Simulate 10 scans × 5 confirmed each, no rejects.
    for (let i = 0; i < 10; i++) {
      recordSkepticOutcomes(tmpDir, KEY, { confirmed: 5, downgraded: 0, rejected: 0 });
    }
    const stats = listProviderStats(tmpDir).providers[KEY];
    expect(adjudicatedTotal(stats)).toBe(50);
    expect(rejectRate(stats)).toBe(0);
    expect(isAgreeableSkeptic(stats)).toBe(true);
  });

  it("accumulates but stays healthy with realistic reject rate", () => {
    // 10 scans × (4 confirmed + 1 reject each) = 40 confirmed / 10 rejected.
    for (let i = 0; i < 10; i++) {
      recordSkepticOutcomes(tmpDir, KEY, { confirmed: 4, downgraded: 0, rejected: 1 });
    }
    const stats = listProviderStats(tmpDir).providers[KEY];
    expect(adjudicatedTotal(stats)).toBe(50);
    expect(rejectRate(stats)).toBe(0.2); // 20%
    expect(isAgreeableSkeptic(stats)).toBe(false);
  });
});
