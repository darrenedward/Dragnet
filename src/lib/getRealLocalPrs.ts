import { randomUUID } from "node:crypto";
import fs from "fs";
import path from "path";
import { prisma } from "@/src/lib/prisma";
import { runGitInRepo, type RepoLike } from "./repoAccess";

/**
 * Postgres TEXT columns reject NUL bytes (0x00) — git can produce them
 * when the diff includes binary files. Strip them so the insert doesn't
 * blow up with `invalid byte sequence for encoding "UTF8": 0x00`.
 */
function sanitizeForPg(s: string): string {
  return s.replace(/\0/g, "");
}

/**
 * Tiny glob matcher — supports "*" and "?" only. Sufficient for branchPattern
 * values like "feature/*", "fix/*", or "*". Brace expansion not supported.
 */
function branchMatches(pattern: string, name: string): boolean {
  if (pattern === "*" || pattern === "") return true;
  const regexStr =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  return new RegExp(regexStr).test(name);
}

interface BranchInfo {
  name: string;
  hash: string;
  date: string;
  author: string;
  subject: string;
}

interface RepoFile {
  filename: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  originalContent: string;
  modifiedContent: string;
  diff: string;
}

const FILE_DIFF_TIMEOUT_MS = 120_000;

/**
 * Run a read-only git command in either local-path or remote-volume
 * mode. Throws on non-zero exit; callers that want fail-open semantics
 * must catch.
 */
async function runGitOrThrow(repo: RepoLike, args: string[], timeoutMs?: number): Promise<string> {
  const { stdout, stderr, exitCode } = await runGitInRepo(repo, args, { timeoutMs });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr || stdout}`);
  }
  return stdout;
}

/**
 * For local-path mode, verify the directory actually exists before we
 * try to run any git commands. Remote-volume mode skips this check
 * entirely — the clone either succeeded or it didn't, and that's
 * surfaced by runGitInRepo failing.
 */
function localPathExists(repo: RepoLike): boolean {
  if (!repo.path) return false;
  const resolved = path.isAbsolute(repo.path)
    ? repo.path
    : path.resolve(process.cwd(), repo.path);
  try {
    return fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Deterministic local-branch → PR detection.
 *
 * Stability properties:
 *  - Branch list ordering: `git for-each-ref --sort=refname` returns
 *    branches in alphabetical order every time.
 *  - `createdAt`: uses the branch tip's committerdate (iso-strict), so
 *    the value is invariant across runs.
 *  - `id`: derived from `repoId + branch name` — never changes for a
 *    given branch.
 *  - Stale PRs: branches that no longer exist (or no longer match the
 *    pattern) have their PR records deleted. The DB state converges to
 *    exactly the set of currently-matching branches.
 *  - Files: deleted + recreated per scan, so file content always
 *    matches the current diff.
 *
 * Branches that produce zero file changes against base (already merged
 * or rebased) still get a PR record so the user can see them and
 * reviews can return cached or metadata-based ratings.
 *
 * Supports both legacy (local-path) and remote-volume repos via
 * `runGitInRepo`. For remote-volume, the repo is assumed to already be
 * cloned — call `gitService.syncToCommit({ commitHash: "HEAD" })`
 * before this if you need a guaranteed-fresh clone.
 */
export async function getRealLocalPrs(repo: RepoLike) {
  const repoId = repo.id;
  console.log(`[scan] getRealLocalPrs: repoId=${repoId} mode=${repo.path ? "local-path" : "remote-volume"}`);
  try {
    if (repo.path && !localPathExists(repo)) {
      console.log(`[scan] getRealLocalPrs: local path not found or not a directory: ${repo.path}`);
      return null;
    }

    try {
      await runGitOrThrow(repo, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return null;
    }

    const repoRow = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repoRow) return null;

    const baseBranch = await detectBaseBranch(repo, repoRow.baseBranch);
    const allBranches = await listBranches(repo);

    const pattern = repoRow.branchPattern || "*";
    const matchingBranches = allBranches.filter(
      (b) => b.name !== baseBranch && branchMatches(pattern, b.name),
    );
    const liveBranchNames = new Set(matchingBranches.map((b) => b.name));

    const existingPrs = await prisma.pullRequest.findMany({
      where: { repoId },
      select: { id: true, sourceBranch: true },
    });
    const stalePrIds = existingPrs
      .filter((p) => !liveBranchNames.has(p.sourceBranch))
      .map((p) => p.id);
    if (stalePrIds.length > 0) {
      await prisma.pullRequest.deleteMany({ where: { id: { in: stalePrIds } } });
    }

    const prs: any[] = [];

    for (const branch of matchingBranches) {
      try {
        const prId = `real-pr-${repoId}-${branch.name.replace(/\//g, "-")}`;

        const merged = await isBranchMerged(repo, baseBranch, branch.name);
        if (merged) {
          const existing = await prisma.pullRequest.findUnique({
            where: { id: prId },
            select: { id: true, status: true },
          });
          if (existing && existing.status !== "Merged") {
            await prisma.pullRequest.update({
              where: { id: prId },
              data: { status: "Merged", commitHash: branch.hash },
            });
            console.log(`[scan] getRealLocalPrs: marked ${prId} as Merged`);
          }
          continue;
        }

        const filesList = await collectBranchFiles(repo, baseBranch, branch.name);

        const existing = await prisma.pullRequest.findUnique({
          where: { id: prId },
          select: { status: true },
        });
        const status = existing?.status === "In Progress" || existing?.status === "Completed"
          ? existing.status
          : "Pending";

        const prData = {
          repoId,
          title: `PR from local: ${branch.name}`,
          sourceBranch: branch.name,
          targetBranch: baseBranch,
          status,
          author: branch.author,
          commitHash: branch.hash,
          createdAt: branch.date,
          description: branch.subject,
        };

        await prisma.pullRequest.upsert({
          where: { id: prId },
          create: { id: prId, ...prData },
          update: prData,
        });

        await prisma.prFile.deleteMany({ where: { prId } });
        await prisma.prFile.createMany({
          skipDuplicates: true,
          data: filesList.map((file, i) => ({
            id: `file-${prId}-${i}`,
            prId,
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            originalContent: sanitizeForPg(file.originalContent),
            modifiedContent: sanitizeForPg(file.modifiedContent),
            diff: sanitizeForPg(file.diff),
          })),
        });

        prs.push({ id: prId, ...prData });
      } catch (branchErr) {
        console.warn(`Skipping branch ${branch.name} during PR scan:`, branchErr);
      }
    }

    return prs;
  } catch (e) {
    console.warn("Failed scanning Git directory content", e);
    return null;
  }
}

async function detectBaseBranch(repo: RepoLike, configuredBase: string): Promise<string> {
  const candidates = [configuredBase, "main", "master"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await runGitOrThrow(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
      return candidate;
    } catch {}
  }
  try {
    const out = await runGitOrThrow(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return out.trim();
  } catch {
    return "main";
  }
}

export async function isBranchMerged(repo: RepoLike, baseBranch: string, branch: string): Promise<boolean> {
  try {
    await runGitOrThrow(repo, ["merge-base", "--is-ancestor", branch, baseBranch]);
    return true;
  } catch {
    return false;
  }
}

async function listBranches(repo: RepoLike): Promise<BranchInfo[]> {
  const stdout = await runGitOrThrow(repo, [
    "for-each-ref",
    "refs/heads/",
    "--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)|%(authorname)|%(subject)",
    "--sort=refname",
  ]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const parts = line.split("|");
    return {
      name: parts[0] || "",
      hash: parts[1] || "HEAD",
      date: parts[2] || new Date().toISOString(),
      author: parts[3] || "Local Dev",
      subject: parts.slice(4).join("|") || "Auto-detected branch",
    };
  });
}

export async function refreshPrFiles(repo: RepoLike, branchName: string, prId: string) {
  const repoRow = await prisma.repository.findUnique({
    where: { id: repo.id },
    select: { baseBranch: true },
  });
  const baseBranch = repoRow?.baseBranch || "main";
  const files = await collectBranchFiles(repo, baseBranch, branchName);
  await prisma.prFile.deleteMany({ where: { prId } });
  if (files.length > 0) {
    await prisma.prFile.createMany({
      skipDuplicates: true,
      data: files.map((f) => ({
        id: randomUUID(),
        prId,
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        originalContent: sanitizeForPg(f.originalContent),
        modifiedContent: sanitizeForPg(f.modifiedContent),
        diff: sanitizeForPg(f.diff),
      })),
    });
  }
  return files;
}

async function collectBranchFiles(
  repo: RepoLike,
  baseBranch: string,
  branchName: string,
): Promise<RepoFile[]> {
  const files: RepoFile[] = [];
  let changedFilesLines: string[] = [];
  try {
    const stdout = await runGitOrThrow(repo, ["diff", "--name-status", `${baseBranch}...${branchName}`]);
    changedFilesLines = stdout.trim().split("\n").filter(Boolean);
  } catch {
    return files;
  }

  for (const fLine of changedFilesLines) {
    const parts = fLine.split(/\s+/);
    const statusChar = parts[0];
    const filename = parts[1];
    if (!filename) continue;

    let diffStr = "";
    let originalContent = "";
    let modifiedContent = "";

    try {
      diffStr = await runGitOrThrow(
        repo,
        ["diff", `${baseBranch}...${branchName}`, "--", filename],
        FILE_DIFF_TIMEOUT_MS,
      );
    } catch {}
    try {
      originalContent = await runGitOrThrow(repo, ["show", `${baseBranch}:${filename}`]);
    } catch {}
    try {
      modifiedContent = await runGitOrThrow(repo, ["show", `${branchName}:${filename}`]);
    } catch {}

    const additions = diffStr.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const deletions = diffStr.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

    files.push({
      filename,
      status: statusChar === "A" ? "added" : statusChar === "D" ? "deleted" : "modified",
      additions,
      deletions,
      originalContent,
      modifiedContent,
      diff: diffStr,
    });
  }
  return files;
}