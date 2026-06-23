import path from "path";
import fs from "fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "child_process";
import { prisma } from "@/src/lib/prisma";

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

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
 * or rebased) are skipped — they aren't real pending PRs.
 */
export async function getRealLocalPrs(repoPath: string, repoId: string) {
  try {
    const resolvedPath = path.isAbsolute(repoPath) ? repoPath : path.resolve(/* turbopackIgnore: true */ process.cwd(), repoPath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) return null;

    try {
      git(["rev-parse", "--is-inside-work-tree"], resolvedPath);
    } catch {
      return null;
    }

    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return null;

    const baseBranch = detectBaseBranch(resolvedPath, repo.baseBranch);
    const allBranches = listBranches(resolvedPath);

    // Filter to branches matching the pattern, excluding the base branch.
    const pattern = repo.branchPattern || "*";
    const matchingBranches = allBranches.filter(
      (b) => b.name !== baseBranch && branchMatches(pattern, b.name),
    );
    const liveBranchNames = new Set(matchingBranches.map((b) => b.name));

    // Stale cleanup: delete PRs whose sourceBranch is no longer live.
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
      // Wrap per-branch work in try/catch so a single failure (binary
      // file, race with repo delete, transient pool timeout) doesn't
      // abort the entire scan — other branches still get processed.
      try {
        const filesList = collectBranchFiles(resolvedPath, baseBranch, branch.name);
        if (filesList.length === 0) continue;

        const prId = `real-pr-${repoId}-${branch.name.replace(/\//g, "-")}`;
        const prData = {
          repoId,
          title: `PR from local: ${branch.name}`,
          sourceBranch: branch.name,
          targetBranch: baseBranch,
          status: "Pending",
          author: branch.author,
          commitHash: branch.hash,
          createdAt: branch.date,
          description: branch.subject,
        };

        // Upsert handles both create and update atomically.
        await prisma.pullRequest.upsert({
          where: { id: prId },
          create: { id: prId, ...prData },
          update: prData,
        });

        // Replace file rows for this PR. We deliberately do NOT wrap in a
        // transaction — the Supabase transaction pooler (PgBouncer) caps
        // interactive transactions at 5s, and the diff fetches can exceed
        // that. Sequential delete + batched createMany is good enough for
        // a dev tool: the next poll cycle repairs any partial state.
        await prisma.prFile.deleteMany({ where: { prId } });
        await prisma.prFile.createMany({
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

/**
 * Resolves the base branch deterministically. Order:
 *   1. repo.baseBranch (if it exists in the repo)
 *   2. main
 *   3. master
 *   4. currently-checked-out branch (HEAD)
 *   5. fallback to "main"
 */
function detectBaseBranch(repoPath: string, configuredBase: string): string {
  const candidates = [configuredBase, "main", "master"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], repoPath);
      return candidate;
    } catch {}
  }
  try {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath).toString().trim();
  } catch {
    return "main";
  }
}

/**
 * Returns all local branches sorted alphabetically by name. The
 * `--sort=refname` flag guarantees stable ordering across runs.
 */
function listBranches(repoPath: string): BranchInfo[] {
  const buffer = git(
    [
      "for-each-ref",
      "refs/heads/",
      "--format=%(refname:short)|%(objectname:short)|%(committerdate:iso-strict)|%(authorname)|%(subject)",
      "--sort=refname",
    ],
    repoPath,
  );
  const lines = buffer.toString().trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const parts = line.split("|");
    return {
      name: parts[0] || "",
      hash: parts[1] || "HEAD",
      date: parts[2] || new Date().toISOString(),
      author: parts[3] || "Local Dev",
      // Subject can contain pipes — rejoin the rest.
      subject: parts.slice(4).join("|") || "Auto-detected branch",
    };
  });
}

export async function refreshPrFiles(repoPath: string, baseBranch: string, branchName: string, prId: string) {
  const files = collectBranchFiles(repoPath, baseBranch, branchName);
  // Deliberately NOT wrapped in $transaction. The Supabase transaction
  // pooler (PgBouncer) caps interactive transactions at 5s; the createMany
  // payload here carries full file contents + diffs and routinely exceeds
  // that on real PRs (we saw 13s on a feature/bug-demo scan). A transaction
  // wrapper turns a slow write into a hard error. Sequential delete +
  // createMany is the same pattern used in getRealLocalPrs() above — see
  // the comment there for the full rationale. The "partial state leaves
  // zero files" risk is repaired by the next refresh cycle.
  await prisma.prFile.deleteMany({ where: { prId } });
  if (files.length > 0) {
    await prisma.prFile.createMany({
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
}

function collectBranchFiles(
  repoPath: string,
  baseBranch: string,
  branchName: string,
): RepoFile[] {
  const files: RepoFile[] = [];
  try {
    const changedFilesBuffer = git(
      ["diff", "--name-status", `${baseBranch}...${branchName}`],
      repoPath,
    );
    const changedFilesLines = changedFilesBuffer.toString().trim().split("\n").filter(Boolean);

    for (const fLine of changedFilesLines) {
      const parts = fLine.split(/\s+/);
      const statusChar = parts[0];
      const filename = parts[1];
      if (!filename) continue;

      let diffStr = "";
      let originalContent = "";
      let modifiedContent = "";

      try {
        diffStr = git(["diff", `${baseBranch}...${branchName}`, "--", filename], repoPath).toString();
      } catch {}
      try {
        originalContent = git(["show", `${baseBranch}:${filename}`], repoPath).toString();
      } catch {}
      try {
        modifiedContent = git(["show", `${branchName}:${filename}`], repoPath).toString();
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
  } catch (err) {
    console.error(`Git diff failed for branch ${branchName}`, err);
  }
  return files;
}
