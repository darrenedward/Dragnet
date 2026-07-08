import { randomUUID } from "node:crypto";
import fs from "fs";
import path from "path";
import { prisma } from "@/src/lib/prisma";
import { runGitInRepo, type RepoLike } from "./repoAccess";
import { getInstallationToken } from "@/src/lib/githubApp";
import { decryptSecret, hasMasterKey } from "@/src/lib/crypto";

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
 * Parse a GitHub clone URL and return owner + repo.
 * Supports https://github.com/o/r.git and git@github.com:o/r.git.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const https = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = url.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

/**
 * Fetch live PRs from GitHub's REST API for a repo.
 *
 * Returns `{ open, merged }` — `open` are currently-open PRs and
 * `merged` are recently-closed PRs that were merged (so the DB can
 * mark them as Merged and they stop appearing in the sidebar).
 *
 * Returns `null` when the URL isn't GitHub or auth fails — caller
 * should fall back to local-branch detection in that case.
 */
async function fetchGitHubPrs(repo: RepoLike): Promise<{
  open: { number: number; title: string; headRef: string; baseRef: string; updatedAt: string }[];
  merged: { number: number; headRef: string }[];
} | null> {
  if (!repo.cloneUrl) return null;
  const parsed = parseGitHubUrl(repo.cloneUrl);
  if (!parsed) return null;

  let token: string | undefined;
  if (repo.installationId) {
    try {
      token = await getInstallationToken(repo.installationId);
    } catch (err: any) {
      console.warn(`[scan] getRealPrs: GitHub auth token failed for ${repo.id}:`, err.message);
    }
  }
  if (!token && repo.patCipher && repo.patIv && repo.patTag && hasMasterKey()) {
    try {
      token = decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
    } catch {}
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "dragnet/1.0",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`;

  // Open PRs
  const openRes = await fetch(`${apiBase}?state=open&per_page=100`, { headers });
  if (!openRes.ok) {
    console.warn(`[scan] getRealPrs: GitHub API ${openRes.status} for open PRs in ${parsed.owner}/${parsed.repo}`);
    return null;
  }
  const openRaw = (await openRes.json()) as any[];
  const open = openRaw.map((pr) => ({
    number: pr.number,
    title: pr.title || `PR #${pr.number}`,
    headRef: pr.head?.ref || "",
    baseRef: pr.base?.ref || "main",
    updatedAt: pr.updated_at || new Date().toISOString(),
  }));

  // Recently closed (last 30) to detect merges
  const closedRes = await fetch(`${apiBase}?state=closed&sort=updated&direction=desc&per_page=30`, {
    headers,
  });
  const merged: { number: number; headRef: string }[] = [];
  if (closedRes.ok) {
    const closedRaw = (await closedRes.json()) as any[];
    for (const pr of closedRaw) {
      if (pr.merged_at) {
        merged.push({ number: pr.number, headRef: pr.head?.ref || "" });
      }
    }
  }

  return { open, merged };
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
 * Deterministic PR detection — fetches live PRs from GitHub API
 * for remote repos (so the DB always matches GitHub's current state:
 * new PRs appear, merged PRs are removed). Falls back to local-branch
 * detection for local-path repos or when the GitHub API is unavailable.
 *
 * Stability properties:
 *  - For remote repos with a GitHub cloneUrl: PRs come directly from
 *    `GET /repos/:owner/:repo/pulls?state=open` + recently closed PRs.
 *    New PRs are upserted into the DB; merged PRs are deleted from the
 *    DB so they no longer appear in the sidebar.
 *  - For local-path repos: branches are listed via git, matching the
 *    old behaviour (branch list ordering, createdAt, id all stable).
 *  - Stale PRs (branches that no longer exist on GitHub/local) have
 *    their records deleted. The DB state converges to exactly the set
 *    of currently-live PRs.
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
export async function getRealPrs(repo: RepoLike) {
  const repoId = repo.id;
  console.log(`[scan] getRealPrs: repoId=${repoId} mode=${repo.path ? "local-path" : "remote-volume"}`);

  // For GitHub repos with credentials, fetch live PRs from the API so the
  // DB always reflects GitHub's current state (new PRs appear, merged
  // PRs are deleted from the sidebar). We only attempt this when we have
  // a way to authenticate (GitHub App installation token or PAT) — without
  // it the API would 401 and we'd silently fall back to local detection.
  if (
    repo.cloneUrl &&
    repo.cloneUrl.includes("github.com") &&
    (repo.installationId || (repo.patCipher && repo.patIv && repo.patTag))
  ) {
    const livePrs = await fetchGitHubPrs(repo);
    if (livePrs !== null) {
      // Upsert live PRs into DB
      for (const ghPr of livePrs.open) {
        const prId = `real-pr-${repoId}-${ghPr.headRef.replace(/\//g, "-")}`;
        await prisma.pullRequest.upsert({
          where: { id: prId },
          create: {
            id: prId,
            repoId,
            title: ghPr.title,
            sourceBranch: ghPr.headRef,
            targetBranch: ghPr.baseRef,
            status: "Pending",
            author: "GitHub",
            commitHash: "",
            createdAt: ghPr.updatedAt,
            description: `GitHub PR #${ghPr.number}`,
          },
          update: {
            title: ghPr.title,
            sourceBranch: ghPr.headRef,
            targetBranch: ghPr.baseRef,
          },
        });
      }

      // Mark merged PRs as Merged in DB
      for (const ghPr of livePrs.merged) {
        const prId = `real-pr-${repoId}-${ghPr.headRef.replace(/\//g, "-")}`;
        await prisma.pullRequest.updateMany({
          where: { id: prId },
          data: { status: "Merged", commitHash: "" },
        });
      }

      // Delete DB records for branches that no longer exist on GitHub
      // (they were closed without being merged, or the branch was deleted)
      const liveBranchNames = new Set(livePrs.open.map((p) => p.headRef));
      const existingPrs = await prisma.pullRequest.findMany({
        where: { repoId },
        select: { id: true, sourceBranch: true, status: true },
      });
      const staleIds = existingPrs
        .filter((p) => !liveBranchNames.has(p.sourceBranch) && p.status === "Pending")
        .map((p) => p.id);
      if (staleIds.length > 0) {
        await prisma.pullRequest.deleteMany({ where: { id: { in: staleIds } } });
        console.log(`[scan] getRealPrs: removed ${staleIds.length} stale PR(s) for ${repoId}`);
      }

      return livePrs.open.map((p) => ({
        id: `real-pr-${repoId}-${p.headRef.replace(/\//g, "-")}`,
        title: p.title,
        sourceBranch: p.headRef,
        targetBranch: p.baseRef,
        status: "Pending",
        author: "GitHub",
        commitHash: "",
        createdAt: p.updatedAt,
        description: `GitHub PR #${p.number}`,
      }));
    }
    // else: fall through to local-branch detection as a fallback
  }

  try {
    if (repo.path && !localPathExists(repo)) {
      console.log(`[scan] getRealPrs: local path not found or not a directory: ${repo.path}`);
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
            console.log(`[scan] getRealPrs: marked ${prId} as Merged`);
          }
          continue;
        }

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

        const filesList = await collectBranchFiles(repo, baseBranch, branch.name);

        await prisma.prFile.deleteMany({ where: { prId } });
        if (filesList.length > 0) {
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
        }

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

// In-memory guard: prevents concurrent refreshPrFiles for the same prId.
// Without this, multiple scan requests that arrive before the review lock
// is acquired ALL call collectBranchFiles simultaneously, spawning
// N × (numFiles × 3) Docker containers and overwhelming the host.
const activeFileRefreshes = new Set<string>();

export async function refreshPrFiles(repo: RepoLike, branchName: string, prId: string) {
  if (activeFileRefreshes.has(prId)) {
    console.log(`[refreshPrFiles] already in progress for ${prId} — returning existing files`);
    const existing = await prisma.prFile.findMany({
      where: { prId },
      select: {
        filename: true,
        status: true,
        additions: true,
        deletions: true,
        originalContent: true,
        modifiedContent: true,
        diff: true,
      },
    });
    return existing.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      originalContent: f.originalContent ?? "",
      modifiedContent: f.modifiedContent ?? "",
      diff: f.diff ?? "",
    }));
  }
  activeFileRefreshes.add(prId);
  try {
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
  } finally {
    activeFileRefreshes.delete(prId);
  }
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