import crypto from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import { runPrScan } from "../../../reviewService";

export interface HostedPrData {
  prNumber: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  commitHash: string;
  author?: string;
  description?: string;
}

export type HostedScanResult =
  | { ok: true; prId: string; runId?: string }
  | { ok: false; error: string };

type ValidateResult = { ok: true } | { ok: false; error: string };

export async function validateHostedMode(repoId: string): Promise<ValidateResult> {
  const repo = await prisma.repository.findUnique({
    where: { id: repoId },
    select: { id: true, hostedMode: true },
  });
  if (!repo) return { ok: false, error: "Repository not found" };
  if (!repo.hostedMode) return { ok: false, error: "Repository is not in hosted mode" };
  return { ok: true };
}

export async function triggerHostedScan(
  repoId: string,
  data: HostedPrData,
): Promise<HostedScanResult> {
  const mode = await validateHostedMode(repoId);
  if (!mode.ok) return { ok: false, error: (mode as { error: string }).error };

  const existingPr = await prisma.pullRequest.findFirst({
    where: { repoId, sourceBranch: data.headBranch, targetBranch: data.baseBranch },
    orderBy: { createdAt: "desc" },
  });

  const pr = existingPr
    ? await prisma.pullRequest.update({
        where: { id: existingPr.id },
        data: {
          title: data.title,
          commitHash: data.commitHash,
          description: data.description ?? null,
          author: data.author ?? "hosted",
          status: "Pending",
        },
      })
    : await prisma.pullRequest.create({
        data: {
          id: crypto.randomUUID(),
          repoId,
          title: data.title,
          sourceBranch: data.headBranch,
          targetBranch: data.baseBranch,
          commitHash: data.commitHash,
          author: data.author ?? "hosted",
          status: "Pending",
          createdAt: new Date().toISOString(),
        },
      });

  const scanResult = (await runPrScan(pr.id)) as unknown as Record<string, unknown>;

  return {
    ok: true,
    prId: pr.id,
    runId: typeof scanResult?.runId === "string" ? scanResult.runId : undefined,
  } as HostedScanResult;
}
