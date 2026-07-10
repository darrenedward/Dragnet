import { runGitInRepo, type RepoLike } from "./repoAccess";

export async function readPrCommitCount(
  repo: RepoLike,
  baseBranch: string | null | undefined,
  sourceBranch: string | null | undefined,
): Promise<number | null> {
  if ((!repo.path && !repo.cloneUrl) || !baseBranch || !sourceBranch) return null;
  const { stdout, exitCode } = await runGitInRepo(repo, [
    "rev-list",
    "--count",
    `${baseBranch}...${sourceBranch}`,
  ]);
  if (exitCode !== 0) return null;
  const parsed = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}