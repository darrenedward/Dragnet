import { runDeterministicChecks, runContainerizedChecks, type DeterministicFinding } from "@/src/services/deterministicChecks";
import { detectBuildSystem } from "@/src/lib/buildsystemDetect";
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
    select: { repoId: true },
  });
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);

  const [repo, pr] = await Promise.all([
    prisma.repository.findUnique({
      where: { id: run.repoId },
      select: {
        id: true,
        path: true,
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
        localPath: true,
      },
    }),
    prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { commitHash: true },
    }),
  ]);
  if (!repo) throw new Error(`Repository ${run.repoId} not found for global deterministic checks.`);
  if (!pr) throw new Error(`Pull request ${prId} not found for global deterministic checks.`);

  const findings: DeterministicFinding[] = [];

  // Tier 1: tsc/eslint (non-critical — crashes produce info findings, no abort)
  let tier1HadErrors = false;
  if (repo.path) {
    try {
      const tier1 = await runDeterministicChecks(repo.path);
      findings.push(...tier1);
      tier1HadErrors = tier1.some((f) => f.severity === "error");
    } catch (err: any) {
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

  // Detect build system for Tier 2 gating
  let tier2Supported = true;
  if (repo.path) {
    try {
      const detected = await detectBuildSystem(repo.path);
      tier2Supported = detected.buildSystem === "node";
    } catch {
      // Fall through — assume supported
    }
  }

  // Tier 2: containerized checks (infrastructure errors do abort)
  const skipTier2 = repo.skipTier2 ?? false;
  const tier2ShouldRun =
    (Boolean(repo.path) || Boolean(repo.cloneUrl)) &&
    !skipTier2 && !tier1HadErrors && tier2Supported;

  if (tier2ShouldRun) {
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
      const tier2Image = repo.path
        ? (repo.runnerImage ?? "node:20-alpine")
        : (repo.runnerImage ?? "node:20-alpine");

      const tier2 = await runContainerizedChecks({
        repoId: repo.id,
        cloneUrl: repo.cloneUrl ?? "",
        commitHash: pr.commitHash,
        deployKey,
        pat,
        runnerImage: tier2Image,
        installCommand: repo.installCommand ?? "npm install",
        testCommand: repo.testCommand ?? "npm test && npm run lint",
        prId,
        reviewRunId,
      });
      findings.push(...tier2);
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
}
