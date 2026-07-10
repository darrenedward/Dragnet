import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import type { DeterministicFinding } from "@/src/services/deterministicChecks";
import { resolveSymbolsBatch, buildFindingFingerprint } from "../fingerprint";

/**
 * Persist global deterministic findings (Tier 1+2) exactly once per scan
 * with reviewChunkId: null. This avoids N redundant DB writes when the
 * same findings are appended to each chunk's output in large-PR mode.
 */
export async function persistGlobalDeterministicFindings(
  reviewRunId: string,
  prId: string,
  repoId: string,
  findings: DeterministicFinding[],
): Promise<void> {
  if (findings.length === 0) return;

  const symbolMap = await resolveSymbolsBatch(
    repoId,
    findings.map((f) => ({ filePath: f.filename, line: f.line })),
  );

  const findingsData = findings.map((finding) => {
    const resolution = symbolMap.get(`${finding.filename}:${finding.line ?? "?"}`);
    const symbolId = resolution?.symbolId ?? null;
    const sourceHashAtInsert = resolution?.sourceHash ?? null;
    const fingerprint = buildFindingFingerprint({
      symbolId,
      filePath: finding.filename,
      category: finding.category,
    });

    return {
      id: randomUUID(),
      prId,
      reviewRunId,
      reviewChunkId: null, // Global findings are not tied to a specific chunk
      repoId,
      category: finding.category || "Style",
      severity: finding.severity === "error" ? "blocker" : finding.severity === "warning" ? "warning" : "suggestion",
      exploitability: "moderate",
      impact: "medium",
      filename: finding.filename || "<unattributed>",
      line: finding.line || null,
      explanation: finding.explanation || "No explanation provided.",
      diffSuggestion: finding.diffSuggestion || null,
      evidenceChain: null,
      confidence: null,
      confidenceReason: null,
      verificationStatus: null,
      verificationNote: null,
      source: finding.source ?? "deterministic",
      timestamp: new Date().toISOString(),
      fingerprint,
      firstSeenRunId: reviewRunId,
      lastSeenRunId: reviewRunId,
      status: "open",
      sourceHashAtInsert,
    };
  });

  await prisma.reviewFinding.createMany({ data: findingsData });
  console.log(`[persistence] Persisted ${findingsData.length} global deterministic findings (reviewChunkId: null)`);
}
