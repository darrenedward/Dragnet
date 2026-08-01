import { admitAfkScanJob } from "@/src/services/scanQueue";
import { ensureTipReady } from "@/src/lib/tipReadyAfk";

/**
 * Admit the exact revision observed by the background polling cycle (AFK).
 * Pins commit hash to the observed tip and gates on tip-ready (hash-only when
 * no local clone; scan prelude materializes tip tree/overlay before LLM).
 */
export async function admitPollingScan(input: {
  repoId: string;
  prId: string;
  commitHash: string;
}) {
  const tip = await ensureTipReady({
    repo: { id: input.repoId },
    prId: input.prId,
    providerHeadSha: input.commitHash,
    requireClone: false,
  });
  if (tip.ok === false) {
    console.warn(
      `[poll] tip-ready blocked AFK admit for ${input.prId}: ${tip.gate} ${tip.reason}`,
    );
    return null;
  }
  return admitAfkScanJob({
    repoId: input.repoId,
    prId: input.prId,
    commitHash: tip.headSha,
    triggerReason: "auto",
  });
}
