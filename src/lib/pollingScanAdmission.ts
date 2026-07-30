import { admitAfkScanJob } from "@/src/services/scanQueue";

/** Admit the exact revision observed by the background polling cycle (AFK). */
export function admitPollingScan(input: {
  repoId: string;
  prId: string;
  commitHash: string;
}) {
  return admitAfkScanJob({
    repoId: input.repoId,
    prId: input.prId,
    commitHash: input.commitHash,
    triggerReason: "auto",
  });
}
