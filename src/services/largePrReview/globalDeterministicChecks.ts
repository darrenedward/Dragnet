import {
  runDeterministicChecks,
  runContainerizedChecks,
  logReview,
  DEFAULT_INSTALL_COMMAND,
  type DeterministicFinding,
} from "@/src/services/deterministicChecks";
import {
  planHostTier1,
  planTier2,
  planTier2BindRoot,
  resolveCheckHeadSha,
} from "@/src/lib/tipAlignedChecks";
import { detectBuildSystem } from "@/src/lib/buildsystemDetect";
import { withRetry, isStepFailure } from "@/src/services/stepPipeline";
import { prisma } from "@/src/lib/prisma";

export interface GlobalChecksResult {
  abort: boolean;
  infrastructureFailure: boolean;
  findings: DeterministicFinding[];
  errorMessage?: string;
}

export async function runGlobalDeterministicChecks(
  reviewRunId: string,
  prId: string,
): Promise<GlobalChecksResult> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: { repoId: true, commitHash: true },
  });
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);

  const [repo, pr] = await Promise.all([
    prisma.repository.findUnique({
      where: { id: run.repoId },
      select: {
        id: true,
        path: true,
        localPath: true,
        cloneUrl: true,
        skipTier2: true,
        runnerImage: true,
        installCommand: true,
        testCommand: true,
        deployKeyCipher: true,
        deployKeyIv: true,
        deployKeyTag: true,
        patCipher: true,
        patIv: true,
        patTag: true,
      },
    }),
    prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { commitHash: true },
    }),
  ]);
  if (!repo) throw new Error(`Repository ${run.repoId} not found for global deterministic checks.`);
  if (!pr) throw new Error(`Pull request ${prId} not found for global deterministic checks.`);

  const checkHeadSha = resolveCheckHeadSha({
    tipHeadSha: run.commitHash,
    reviewRunCommitHash: run.commitHash,
    prCommitHash: pr.commitHash,
  });

  const findings: DeterministicFinding[] = [];
  const tier1Plan = planHostTier1(repo, checkHeadSha);
  // Never bind ambient checkout for Tier 2 (container rw install pollutes host).
  const tier2Bind = planTier2BindRoot(tier1Plan, {
    cloneUrl: repo.cloneUrl,
    repoPath: repo.path,
  });
  let tipRootForTier2: string | null = tier2Bind.path;
  const cleanupTipTrees = () => {
    try {
      tier2Bind.cleanup?.();
    } finally {
      if (tier1Plan.action === "run") tier1Plan.cleanup?.();
    }
  };

  try {
    // Tier 1: host tsc/eslint only on tip-aligned tree (never ambient wrong branch).
    let tier1HadErrors = false;
    if (tier1Plan.action === "skip") {
      void logReview(
        prId,
        `[global] Tier 1 skipped: ${tier1Plan.reason}`,
        "info",
        reviewRunId,
      );
    } else {
      try {
        const tier1 = await runDeterministicChecks(tier1Plan.rootPath);
        findings.push(...tier1);
        tier1HadErrors = tier1.some((f) => f.severity === "error");
        const counts = tier1.reduce((acc, f) => {
          acc[f.source] = (acc[f.source] ?? 0) + 1; return acc;
        }, {} as Record<string, number>);
        const summary = Object.keys(counts).length === 0
          ? "clean (no tsc/eslint findings)"
          : Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
        void logReview(
          prId,
          `[global] Tier 1 deterministic checks (${tier1Plan.source} @ ${checkHeadSha.slice(0, 12)}): ${summary}`,
          "info",
          reviewRunId,
        );
      } catch (err: any) {
        void logReview(prId, `[global] Tier 1 deterministic checks crashed: ${err?.message ?? String(err)}`, "warn", reviewRunId);
        findings.push({
          filename: "",
          line: null,
          severity: "info",
          category: "Deterministic Checks",
          explanation: `Tier 1 (tsc/eslint) crashed: ${err?.message ?? String(err)}. Continuing with Tier 2 + LLM.`,
          source: "runner",
        });
      }
    }

    // Detect build system for Tier 2 gating (tip tree only; remote uses node default)
    let tier2Supported = true;
    if (tier1Plan.action === "run") {
      try {
        const detected = await detectBuildSystem(tier1Plan.rootPath);
        tier2Supported = detected.buildSystem === "node";
      } catch {
        // Fall through — assume supported
      }
    }

    // Tier 2: same head SHA as tools; local-only bind or explicit skip.
    const tier2Plan = planTier2({
      headSha: checkHeadSha,
      cloneUrl: repo.cloneUrl,
      tipRootPath: tipRootForTier2,
      skipTier2: repo.skipTier2 ?? false,
      tier1HadErrors,
      tier2Supported,
      hasPathOrClone: Boolean(repo.path) || Boolean(repo.cloneUrl),
    });

    if (tier2Plan.action === "skip") {
      void logReview(prId, `[global] Tier 2 skipped: ${tier2Plan.reason}`, "info", reviewRunId);
    } else {
      try {
        const { decryptSecret, hasMasterKey } = await import("@/src/lib/crypto");
        let deployKey: string | undefined;
        let pat: string | undefined;
        if (repo.deployKeyCipher && repo.deployKeyIv && repo.deployKeyTag && hasMasterKey()) {
          deployKey = decryptSecret(repo.deployKeyCipher, repo.deployKeyIv, repo.deployKeyTag);
        }
        if (repo.patCipher && repo.patIv && repo.patTag && hasMasterKey()) {
          pat = decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
        }
        const tier2Image = repo.runnerImage ?? "node:20-alpine";

        const tier2Result = await withRetry<DeterministicFinding[]>(
          async () => {
            const tier2 = await runContainerizedChecks({
              repoId: repo.id,
              cloneUrl: tier2Plan.action === "sync" ? tier2Plan.cloneUrl : "",
              commitHash: tier2Plan.commitHash,
              hostBindPath: tier2Plan.action === "bind" ? tier2Plan.hostPath : undefined,
              deployKey,
              pat,
              runnerImage: tier2Image,
              installCommand: repo.installCommand ?? DEFAULT_INSTALL_COMMAND,
              testCommand: repo.testCommand,
              prId,
              reviewRunId,
            });
            return { ok: true, data: tier2 };
          },
          { stepName: "Tier2: container checks", maxRetries: 1 },
        );

        if (isStepFailure(tier2Result)) {
          return {
            abort: true,
            infrastructureFailure: true,
            findings,
            errorMessage: `Tier 2 (containerized checks) infrastructure failure: ${tier2Result.error.message}`,
          };
        }
        void logReview(
          prId,
          `[global] Tier 2 containerized checks → ${tier2Result.data.length} result(s) head=${tier2Plan.commitHash.slice(0, 12)} mode=${tier2Plan.action}`,
          "info",
          reviewRunId,
        );
        for (const result of tier2Result.data) {
          if (result.kind === "external_dependency_skip") {
            void logReview(
              prId,
              `[global] External dependency skip (${result.provenance ?? "unknown provenance"}): ${result.explanation}`,
              "warn",
              reviewRunId,
            );
            console.warn(`[global] external dependency skipped — ${result.explanation}`);
          }
        }
        findings.push(...tier2Result.data);
      } catch (err: any) {
        return {
          abort: true,
          infrastructureFailure: true,
          findings,
          errorMessage: `Tier 2 (containerized checks) infrastructure failure: ${err?.message ?? String(err)}`,
        };
      }
    }

    return {
      abort: false,
      infrastructureFailure: false,
      findings,
    };
  } finally {
    cleanupTipTrees();
    tipRootForTier2 = null;
  }
}
