/**
 * Golden confidence fixtures (#151).
 *
 * Pure-path coverage operators can trust without a live LLM:
 *  1. Multi-chunk duplicate fingerprints → one published finding
 *  2. Raising normal max lines via Settings → fewer chunks
 *  3. Cluster merge + no-merge (cluster shipped in-package)
 *
 * Manual ops steps live in GOLDEN_CHECKLIST.md (known-bug / clean / large PR,
 * queue drain with auto-rescan off).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LIMITS,
  clearLimitsCache,
  chunkOptionsFromLimits,
  effectiveChunkLineCap,
  readLimits,
  saveLimits,
  tierThresholdsFromLimits,
} from "../../src/lib/prSizeConfig";
import {
  clusterDuplicateIds,
  planRootCauseClusters,
  type ClusterFinding,
} from "../../src/services/largePrReview/cluster";
import { chunkDiff } from "../../src/services/largePrReview/chunker";
import {
  assertTier,
  buildDiffManifest,
} from "../../src/services/largePrReview/manifest";
import {
  PUBLISH_ORDER,
  selectPublishedSurvivors,
} from "../../src/services/largePrReview/publishFindings";
import { planIntraRunDedup } from "../../src/services/largePrReview/reconcile";
import type { ReviewFileInput } from "../../src/services/largePrReview/types";

function clusterFinding(
  partial: Partial<ClusterFinding> & Pick<ClusterFinding, "id">,
): ClusterFinding {
  return {
    fingerprint: partial.fingerprint ?? `fp-${partial.id}`,
    category: partial.category ?? "Correctness",
    severity: partial.severity ?? "warning",
    filename: partial.filename ?? "a.ts",
    line: partial.line ?? 10,
    explanation:
      partial.explanation ??
      "Null check missing before dereference of user profile object",
    confidence: partial.confidence ?? 0.9,
    evidenceChain: partial.evidenceChain ?? null,
    ...partial,
  };
}

describe("golden confidence (#151)", () => {
  it("publish order is fingerprint → cluster → reverify → reconcile → load", () => {
    expect([...PUBLISH_ORDER]).toEqual([
      "fingerprint_dedupe",
      "root_cause_cluster",
      "reverify_survivors",
      "cross_run_reconcile",
      "load_published",
    ]);
  });

  describe("multi-chunk duplicate fingerprints → one published finding", () => {
    it("same fingerprint from two chunks collapses to the highest-confidence survivor", () => {
      // Chunk 1 and chunk 2 both report the same bug (fp-x); chunk 2 also has a distinct root.
      const findings = [
        {
          id: "chunk1-fp-x",
          fingerprint: "fp-x",
          severity: "warning",
          confidence: 0.8,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "chunk2-fp-x",
          fingerprint: "fp-x",
          severity: "warning",
          confidence: 0.91,
          timestamp: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "chunk2-fp-y",
          fingerprint: "fp-y",
          severity: "blocker",
          confidence: 0.88,
          timestamp: "2026-01-01T00:00:03.000Z",
        },
      ];

      const dupes = planIntraRunDedup(findings);
      const published = selectPublishedSurvivors(findings, dupes);

      expect(dupes).toEqual(["chunk1-fp-x"]);
      expect(published).toHaveLength(2);
      expect(published.map((f) => f.fingerprint).sort()).toEqual(["fp-x", "fp-y"]);
      expect(published.find((f) => f.fingerprint === "fp-x")?.id).toBe("chunk2-fp-x");
    });

    it("three chunks reporting one bug still publish a single finding", () => {
      const findings = [
        {
          id: "c1",
          fingerprint: "fp-bug",
          severity: "suggestion",
          confidence: 0.6,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c2",
          fingerprint: "fp-bug",
          severity: "warning",
          confidence: 0.85,
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "c3",
          fingerprint: "fp-bug",
          severity: "blocker",
          confidence: 0.85,
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ];
      const dupes = planIntraRunDedup(findings);
      const published = selectPublishedSurvivors(findings, dupes);
      expect(published).toHaveLength(1);
      // Tie on confidence → higher severity wins
      expect(published[0].id).toBe("c3");
      expect(dupes.sort()).toEqual(["c1", "c2"].sort());
    });
  });

  describe("raising normal max lines via Settings → fewer chunks", () => {
    let originalCwd: string;
    let tempRoot: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      tempRoot = mkdtempSync(join(tmpdir(), "dragnet-golden-limits-"));
      process.chdir(tempRoot);
      clearLimitsCache();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(tempRoot, { recursive: true, force: true });
      clearLimitsCache();
    });

    /** Synthetic ~1200-line mid-size PR (6 files × 200 lines). */
    const syntheticFiles: ReviewFileInput[] = Array.from({ length: 6 }, (_, i) => ({
      filename: `src/mod${i}.ts`,
      additions: 100,
      deletions: 100,
    }));

    it("default limits produce multiple chunks; saveLimits higher normalMaxLines yields fewer", async () => {
      const tight = readLimits();
      expect(tight).toEqual(DEFAULT_LIMITS);

      const tightManifest = buildDiffManifest(
        syntheticFiles,
        undefined,
        tierThresholdsFromLimits(tight),
      );
      const tightPlans = chunkDiff(tightManifest, [], chunkOptionsFromLimits(tight));
      expect(tightPlans.length).toBeGreaterThan(1);
      expect(assertTier(tightManifest, tierThresholdsFromLimits(tight)).tier).toBe(
        "grouped",
      );

      // Operator raises Normal — max lines in Settings (next scan, no restart).
      await saveLimits({
        ...DEFAULT_LIMITS,
        normalMaxLines: 2000,
        chunkLineCap: 600,
      });
      clearLimitsCache();

      const loose = readLimits();
      expect(loose.normalMaxLines).toBe(2000);
      expect(effectiveChunkLineCap(loose)).toBe(2000);

      const looseManifest = buildDiffManifest(
        syntheticFiles,
        undefined,
        tierThresholdsFromLimits(loose),
      );
      const loosePlans = chunkDiff(looseManifest, [], chunkOptionsFromLimits(loose));

      expect(loosePlans.length).toBeLessThan(tightPlans.length);
      expect(loosePlans).toHaveLength(1);
      expect(assertTier(looseManifest, tierThresholdsFromLimits(loose)).tier).toBe(
        "normal",
      );
    });
  });

  describe("cluster merge + no-merge (shipped)", () => {
    it("merge: high-confidence same-root pair → one multi-location survivor", () => {
      const stem =
        "Missing authorization check on admin endpoint before mutating protected resources";
      const findings = [
        clusterFinding({
          id: "f1",
          filename: "auth/session.ts",
          line: 40,
          explanation: stem,
          confidence: 0.92,
        }),
        clusterFinding({
          id: "f2",
          filename: "auth/admin.ts",
          line: 12,
          explanation: stem,
          confidence: 0.88,
        }),
      ];

      const groups = planRootCauseClusters(findings);
      expect(groups).toHaveLength(1);
      expect(groups[0].keepId).toBe("f1");
      expect(groups[0].multiLocation).toHaveLength(2);
      expect(groups[0].shouldReverify).toBe(true);

      const published = selectPublishedSurvivors(
        findings,
        clusterDuplicateIds(groups),
      );
      expect(published.map((f) => f.id)).toEqual(["f1"]);
    });

    it("no-merge: unrelated categories stay separate", () => {
      const findings = [
        clusterFinding({
          id: "f1",
          category: "Security",
          explanation: "Hardcoded API secret embedded in client bundle configuration",
          confidence: 0.95,
        }),
        clusterFinding({
          id: "f2",
          category: "Performance",
          filename: "b.ts",
          line: 20,
          explanation: "N plus one query pattern inside list rendering loop over users",
          confidence: 0.95,
        }),
      ];

      expect(planRootCauseClusters(findings)).toEqual([]);
      const published = selectPublishedSurvivors(findings, []);
      expect(published).toHaveLength(2);
    });

    it("no-merge: low-confidence pairs stay separate", () => {
      const stem = "Possible race on shared cache invalidation without lock guard";
      const findings = [
        clusterFinding({ id: "f1", explanation: stem, confidence: 0.4 }),
        clusterFinding({
          id: "f2",
          filename: "b.ts",
          line: 22,
          explanation: stem,
          confidence: 0.5,
        }),
      ];

      expect(planRootCauseClusters(findings)).toEqual([]);
      expect(selectPublishedSurvivors(findings, [])).toHaveLength(2);
    });
  });
});
