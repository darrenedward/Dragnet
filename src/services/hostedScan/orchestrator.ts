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

export interface HostedScanResult {
  ok: boolean;
  error?: string;
  prId?: string;
  runId?: string;
}

export async function validateHostedMode(repoId: string): Promise<{ ok: boolean; error?: string }> {
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
  if (!mode.ok) return mode;

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
          status: "Open",
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
          status: "Open",
          createdAt: new Date().toISOString(),
        },
      });

  const scanResult = await runPrScan(pr.id);

  return {
    ok: true,
    prId: pr.id,
    runId: "runId" in scanResult ? (scanResult as any).runId : undefined,
  };
}
