import { admitScanJob } from "@/src/services/scanQueue";

/** Admit the exact revision observed by the background polling cycle. */
export function admitPollingScan(input: {
  repoId: string;
  prId: string;
  commitHash: string;
}) {
  return admitScanJob({
    repoId: input.repoId,
    prId: input.prId,
    commitHash: input.commitHash,
    triggerReason: "auto",
  });
}
