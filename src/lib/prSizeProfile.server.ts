import { execFileSync } from "child_process";

export function readPrCommitCount(
  repoPath: string | null | undefined,
  baseBranch: string | null | undefined,
  sourceBranch: string | null | undefined,
): number | null {
  if (!repoPath || !baseBranch || !sourceBranch) return null;
  try {
    const output = execFileSync(
      "git",
      ["rev-list", "--count", `${baseBranch}...${sourceBranch}`],
      { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim();
    const parsed = Number.parseInt(output, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
