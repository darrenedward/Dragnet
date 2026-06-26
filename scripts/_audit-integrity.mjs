// Read-only integrity audit. Inventories drift between DB state and reality.
// Run with: node scripts/_audit-integrity.mjs
//
// Categories:
//   A. ReviewRuns with legacy/fake shape (model null OR diffHash empty OR id starts with 'legacy-')
//   B. ReviewFindings attached to legacy-* runs
//   C. PRs whose branch is fully merged into base (still listed though)
//   D. PRs with stale commitHash (DB != git rev-parse HEAD of sourceBranch)
//   E. Orphaned ReviewRuns (prId not in PullRequest table)
//   F. Branch-name collisions across PRs (same sourceBranch, different repos)
//
// No writes. No updates. Just inventory.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new pg.Pool({
  connectionString: stripped,
  ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function headCmp(repoPath, branch) {
  return git(repoPath, ["rev-parse", branch]);
}

function isMergedIntoBase(repoPath, baseBranch, branch) {
  // exit 0 → ancestor (merged). exit 128/other → not merged or bad ref.
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, baseBranch], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

console.log("=== GrepLoop integrity audit ===\n");

const repos = await prisma.repository.findMany({ select: { id: true, name: true, path: true, baseBranch: true } });
const prs = await prisma.pullRequest.findMany({
  select: {
    id: true, title: true, sourceBranch: true, targetBranch: true,
    commitHash: true, status: true, repoId: true, createdAt: true,
  },
});
const runs = await prisma.reviewRun.findMany({
  select: {
    id: true, prId: true, status: true, model: true, diffHash: true,
    reviewConfigHash: true, rating: true, triggerReason: true,
    startedAt: true, completedAt: true,
  },
});
const findingsCount = await prisma.reviewFinding.count();

console.log(`Repositories: ${repos.length}`);
console.log(`PullRequests: ${prs.length}`);
console.log(`ReviewRuns:   ${runs.length}`);
console.log(`ReviewFindings (total): ${findingsCount}\n`);

// --- A. Legacy-shape ReviewRuns ---
const legacyRuns = runs.filter(r =>
  r.id.startsWith("legacy-") ||
  r.model === null ||
  r.diffHash === "" ||
  r.diffHash === null
);
console.log(`A. Legacy/fake-shape ReviewRuns: ${legacyRuns.length}`);
if (legacyRuns.length > 0) {
  console.log("   Top offenders:");
  for (const r of legacyRuns.slice(0, 10)) {
    const reasons = [];
    if (r.id.startsWith("legacy-")) reasons.push("legacy-id");
    if (r.model === null) reasons.push("model-null");
    if (!r.diffHash) reasons.push("diffHash-empty");
    console.log(`   - ${r.id}  [${reasons.join(",")}]  rating=${r.rating}  pr=${r.prId}  trigger=${r.triggerReason}`);
  }
  if (legacyRuns.length > 10) console.log(`   ... and ${legacyRuns.length - 10} more`);
}

// --- B. ReviewFindings attached to legacy runs ---
const legacyRunIds = new Set(legacyRuns.map(r => r.id));
const legacyFindings = await prisma.reviewFinding.findMany({
  where: { reviewRunId: { in: [...legacyRunIds] } },
  select: { id: true, reviewRunId: true, source: true, severity: true },
});
console.log(`\nB. Findings attached to legacy runs: ${legacyFindings.length}`);
if (legacyFindings.length > 0) {
  const bySource = legacyFindings.reduce((acc, f) => {
    const k = f.source ?? "(null)";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`   by source: ${JSON.stringify(bySource)}`);
}

// --- C. PRs whose sourceBranch is merged into base ---
console.log(`\nC. PRs whose branch is fully merged into base (still listed):`);
let mergedCount = 0;
const mergedDetails = [];
for (const pr of prs) {
  const repo = repos.find(r => r.id === pr.repoId);
  if (!repo?.path || !existsSync(repo.path)) continue;
  if (!pr.sourceBranch) continue;
  const baseBranch = pr.targetBranch || repo.baseBranch || "main";
  const merged = isMergedIntoBase(repo.path, baseBranch, pr.sourceBranch);
  if (merged) {
    mergedCount++;
    mergedDetails.push({
      prId: pr.id,
      title: pr.title?.slice(0, 60),
      sourceBranch: pr.sourceBranch,
      baseBranch,
      status: pr.status,
    });
  }
}
console.log(`   Merged-but-listed PRs: ${mergedCount}`);
for (const d of mergedDetails.slice(0, 10)) {
  console.log(`   - ${d.prId}  [${d.status}]  ${d.sourceBranch} → ${d.baseBranch}  "${d.title}"`);
}
if (mergedDetails.length > 10) console.log(`   ... and ${mergedDetails.length - 10} more`);

// --- D. PRs with stale commitHash ---
console.log(`\nD. PRs with stale commitHash (DB != actual branch HEAD):`);
let staleHashCount = 0;
const staleHashDetails = [];
for (const pr of prs) {
  const repo = repos.find(r => r.id === pr.repoId);
  if (!repo?.path || !existsSync(repo.path)) continue;
  if (!pr.sourceBranch) continue;
  const actual = headCmp(repo.path, pr.sourceBranch);
  if (!actual) continue;
  if (pr.commitHash && pr.commitHash !== actual) {
    staleHashCount++;
    staleHashDetails.push({
      prId: pr.id,
      sourceBranch: pr.sourceBranch,
      dbHash: pr.commitHash?.slice(0, 8),
      actualHash: actual.slice(0, 8),
    });
  }
}
console.log(`   Stale commitHash PRs: ${staleHashCount}`);
for (const d of staleHashDetails.slice(0, 10)) {
  console.log(`   - ${d.prId}  ${d.sourceBranch}  db=${d.dbHash}  actual=${d.actualHash}`);
}
if (staleHashDetails.length > 10) console.log(`   ... and ${staleHashDetails.length - 10} more`);

// --- E. Orphaned ReviewRuns ---
const prIds = new Set(prs.map(p => p.id));
const orphanRuns = runs.filter(r => !prIds.has(r.prId));
console.log(`\nE. Orphaned ReviewRuns (prId not in PullRequest): ${orphanRuns.length}`);
for (const r of orphanRuns.slice(0, 10)) {
  console.log(`   - ${r.id}  pr=${r.prId}  status=${r.status}  rating=${r.rating}`);
}
if (orphanRuns.length > 10) console.log(`   ... and ${orphanRuns.length - 10} more`);

// --- F. Branch-name collisions ---
console.log(`\nF. Branch-name collisions (same sourceBranch across PRs):`);
const byBranch = new Map();
for (const pr of prs) {
  if (!pr.sourceBranch) continue;
  const key = pr.sourceBranch;
  if (!byBranch.has(key)) byBranch.set(key, []);
  byBranch.get(key).push({ prId: pr.id, repoId: pr.repoId, status: pr.status });
}
let collisionCount = 0;
for (const [branch, list] of byBranch) {
  if (list.length > 1) {
    collisionCount++;
    console.log(`   - "${branch}" → ${list.length} PRs:`);
    for (const l of list.slice(0, 5)) {
      const repoName = repos.find(r => r.id === l.repoId)?.name ?? "?";
      console.log(`       ${l.prId}  [${l.status}]  repo=${repoName}`);
    }
    if (list.length > 5) console.log(`       ... and ${list.length - 5} more`);
  }
}
if (collisionCount === 0) console.log(`   (none)`);

// --- Active in_progress runs (any stragglers) ---
const inProgress = runs.filter(r => r.status === "in_progress");
console.log(`\nG. In-progress ReviewRuns (should be 0 if reaper works): ${inProgress.length}`);
for (const r of inProgress.slice(0, 5)) {
  const ageMs = Date.now() - r.startedAt.getTime();
  const ageMin = Math.round(ageMs / 60000);
  console.log(`   - ${r.id}  age=${ageMin}min  pr=${r.prId}  started=${r.startedAt.toISOString()}`);
}

console.log("\n=== audit complete ===");
await pool.end();
