import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber, findPrByBranch } from "@/src/lib/findPr";
import { refreshPrFiles } from "@/src/lib/getRealPrs";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/reviewService";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { isReviewActive, acquireReviewLock } from "@/src/lib/reviewLocks";
import { getChatChain } from "@/src/lib/llmClient";
import { computePrSizeProfile, type PrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";
import { computeStackTopology, type PrTopologyInput } from "@/src/lib/prStackTopology";
import { assertTier, buildDiffManifest, runLargePrReview } from "@/src/services/largePrReview";
import { readLimits } from "@/src/lib/prSizeConfig";
import { logReview } from "@/src/services/deterministicChecks/logging";
import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
  createReviewRun,
  completeReviewRun,
  getLatestCompletedReview,
  getRecentRuns,
  getActiveScan,
} from "@/src/lib/reviewFreshness";
import { computeStability, computeWeightedStability } from "@/src/lib/stabilityScore";
import { lookupTrustWeight } from "@/src/lib/modelTrustWeights";

/**
 * Start a tracked review: refresh files, create an in_progress ReviewRun,
 * then kick off runPrScan with the run attached. Used by both the JSON-RPC
 * prcheck tool and the legacy `prcheck` command — single source of truth
 * for the triggerReason, file refresh, and run lifecycle.
 *
 * Returns the PR's sourceBranch so callers can format user-facing strings.
 * Returns `conflict: true` if another scan is already running on the PR
 * (caller surfaces a SCAN_IN_PROGRESS message instead of starting a race).
 */
async function startTrackedReview(pr: any, repo: any, userId: string | null): Promise<
  | { sourceBranch: string; sizeProfile: PrSizeProfile }
  | { conflict: true; runId: string; startedAt: Date }
> {
  // Each step logs an info row to reviewLog so the sidebar's "in progress"
  // UI shows what's happening during the 1-15s warm-up where otherwise
  // nothing visible happens. Best-effort: logReview swallows its own errors,
  // so a DB hiccup never blocks the scan.
  void logReview(pr.id, `> Scan requested for ${pr.sourceBranch}`, "info");

  const chatChain = getChatChain();
  void logReview(
    pr.id,
    `> Resolving LLM chain: ${chatChain.length} provider(s) configured${chatChain.length > 0 ? `, primary=${chatChain[0]?.model ?? "unknown"}` : " — chat review will be skipped"}`,
    chatChain.length > 0 ? "info" : "warn",
  );

  let files: any[] = [];
  if ((repo?.path || repo?.cloneUrl) && pr.sourceBranch) {
    void logReview(pr.id, `> Syncing repository (clone path or container fetch)…`, "info");
    try {
      files = await refreshPrFiles(repo, pr.sourceBranch, pr.id);
      void logReview(
        pr.id,
        `> Diff files refreshed — ${files.length} file${files.length === 1 ? "" : "s"} in scope`,
        "info",
      );
    } catch (e) {
      console.warn("[api] prfile refresh failed, using cached:", e);
      void logReview(pr.id, `> WARNING: prfile refresh failed, falling back to cached files: ${(e as Error).message}`, "warn");
    }
  } else {
    void logReview(pr.id, `> No repo path/cloneUrl on the record, skipping file refresh`, "warn");
  }

  const sizeProfile = await loadPrSizeProfile(pr, repo, files.length > 0 ? files : undefined);
  void logReview(
    pr.id,
    `> Size profile computed — tier=${sizeProfile.tier}, codeLines=${sizeProfile.codeLines.toLocaleString()}, files=${sizeProfile.codeFiles}/${sizeProfile.totalFiles}${sizeProfile.message ? ` (${sizeProfile.message})` : ""}`,
    "info",
  );

  const limits = readLimits();
  const manifest = buildDiffManifest(files, sizeProfile.commitCount, {
    normalMaxLines: limits.normalMaxLines,
    normalMaxCodeFiles: limits.normalMaxCodeFiles,
    oversizedLines: limits.oversizedLines,
    oversizedCodeFiles: limits.oversizedCodeFiles,
  });
  const tier = assertTier(manifest);
  const diffHash = computeDiffHash(files);
  const configHash = chatChain.length > 0
    ? computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION), limits)
    : "";

  // Shared concurrency guard via acquireReviewLock — narrows the race
  // window that the previous assertNoActiveScan→createReviewRun→beginReview
  // sequence left open. Same helper as scan/prcheck/prepush so all four
  // entry points share identical guard semantics.
  void logReview(pr.id, `> Acquiring scan lock…`, "info");
  const lock = await acquireReviewLock(pr.id, false);
  if (lock.status === "busy") {
    void logReview(pr.id, `> Scan already in progress (runId=${lock.runId}), aborting`, "warn");
    return {
      conflict: true,
      runId: lock.runId,
      startedAt: lock.startedAt,
    };
  }
  // Phase 7: programmatic entry point can't surface Continue/Start fresh
  // UI, so a stale_inspectable result (only returned when repoPath is
  // passed, which we don't here) is treated as busy. Defensive — narrows
  // the union so the next line's `.release` access type-checks.
  if (lock.status === "stale_inspectable") {
    return {
      conflict: true,
      runId: lock.runId,
      startedAt: lock.startedAt,
    };
  }
  const releaseLock = lock.release;

  const reviewRunId = await createReviewRun({
    prId: pr.id,
    repoId: pr.repoId,
    commitHash: pr.commitHash,
    diffHash,
    reviewConfigHash: configHash,
    model: chatChain[0]?.model ?? null,
    triggerReason: "prcheck",
    createdByUserId: userId,
  });

  if (tier.tier === "normal") {
    void logReview(pr.id, `> Scan started — single-shot mode (no chunking), runId=${reviewRunId}`, "info");
  } else {
    void logReview(pr.id, `> Scan started — Large PR mode (${tier.tier}), splitting into chunks, runId=${reviewRunId}`, "info");
  }

  const runPromise = tier.tier === "normal"
    ? runPrScan(pr.id, files, reviewRunId)
    : runLargePrReview({
        reviewRunId,
        prId: pr.id,
        files,
        tier: tier.tier,
        warning: "message" in tier ? tier.message : null,
      });

  runPromise.then((sr) => {
    releaseLock();
    prisma.pullRequest.updateMany({ where: { id: pr.id }, data: { rating: sr.rating } }).catch(() => {});
    console.log(`[api] review complete for ${pr.sourceBranch}: ${sr.rating}/10`);
  }).catch((err) => {
    releaseLock();
    // Mark the run failed — without this, the run stays in_progress and
    // the next command invocation 409s with SCAN_IN_PROGRESS.
    completeReviewRun(reviewRunId, { status: "failed" }).catch((e) => {
      console.error(`[api] failed to mark ReviewRun ${reviewRunId} failed:`, e);
    });
    console.error(`[api] review failed for ${pr.sourceBranch}:`, err);
  });

  return { sourceBranch: pr.sourceBranch, sizeProfile };
}

async function loadPrSizeProfile(pr: any, repo?: any, refreshedFiles?: any[]): Promise<PrSizeProfile> {
  const profileRepo = repo ?? await prisma.repository.findUnique({
    where: { id: pr.repoId },
    select: {
      path: true,
      baseBranch: true,
      cloneUrl: true,
      cloneUrlHttps: true,
      deployKeyCipher: true,
      deployKeyIv: true,
      deployKeyTag: true,
      patCipher: true,
      patIv: true,
      patTag: true,
    },
  });
  const files = refreshedFiles ?? await prisma.prFile.findMany({
    where: { prId: pr.id },
    select: { filename: true, additions: true, deletions: true },
  });
  const commitCount = await readPrCommitCount(
    profileRepo,
    pr.targetBranch || profileRepo?.baseBranch || "main",
    pr.sourceBranch,
  );
  return computePrSizeProfile(files, commitCount);
}

function formatSizeProfile(profile: PrSizeProfile): string {
  return `${profile.label}${profile.message ? ` - ${profile.message}` : ""}`;
}

function defaultRepoId(url: string, args?: string[]): string | null {
  if (args && args.length > 0) return args[0];
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[0] === "api" && parts[1] === "command") {
      return parts[2] || null;
    }
  } catch {}
  return null;
}

function withDefaultRepo(args: any, defRepo: string | null): any {
  if (defRepo && !args.repoId) return { ...args, repoId: defRepo };
  return args;
}

function toolsWithRepo(repo: string | null): any[] {
  const suffix = repo ? ` (repo: ${repo})` : "";
  return [
    {
      name: "prcheck",
      description: `Start a review of a pull request. Pass number=PR_ID (e.g. "5"), or repoId+branch. Returns immediately — check results later with prcheckstatus.${suffix}`,
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "string", description: "PR number (e.g. '5')" },
          repoId: { type: "string", description: `Repository ID${repo ? " (defaults to this connection's repo)" : ""}` },
          branch: { type: "string", description: "Branch name (used with repoId)" },
        },
      },
    },
    {
      name: "prcheckstatus",
      description: `Get the result of a previously started PR review. Pass number or repoId+branch. Returns rating + findings if done, or progress status.${suffix}`,
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "string", description: "PR number (e.g. '5')" },
          repoId: { type: "string", description: `Repository ID${repo ? " (defaults to this connection's repo)" : ""}` },
          branch: { type: "string", description: "Branch name (used with repoId)" },
        },
      },
    },
    {
      name: "prcomments",
      description: `Get persisted review findings for a pull request.${suffix}`,
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "string", description: "PR number (e.g. '5')" },
          repoId: { type: "string", description: `Repository ID${repo ? " (defaults to this connection's repo)" : ""}` },
          branch: { type: "string", description: "Branch name (used with repoId)" },
        },
      },
    },
    {
      name: "prlist",
      description: `List all pull requests with their ratings.${repo ? "" : " Requires repoId."}`,
      inputSchema: repo
        ? { type: "object", properties: {}, description: "Lists PRs for the configured repo." }
        : {
            type: "object",
            properties: { repoId: { type: "string", description: "Repository ID (required)" } },
            required: ["repoId"],
          },
    },
  ];
}

async function resolvePrFromArgs(args: any): Promise<any | null> {
  let pr = args.number ? await findPrByIdOrNumber(args.number, args.repoId) : null;
  if (pr && args.repoId && pr.repoId !== args.repoId) pr = null;
  if (!pr && args.repoId && args.branch) pr = await findPrByBranch(args.repoId, args.branch);
  if (!pr && args.number && /^\d+$/.test(String(args.number)) && args.repoId) {
    const ordinal = await prisma.pullRequest.findMany({
      where: { repoId: args.repoId },
      orderBy: { createdAt: "asc" },
      skip: parseInt(String(args.number), 10) - 1,
      take: 1,
    });
    if (ordinal.length > 0) pr = ordinal[0];
  }
  return pr;
}

function formatFindings(pr: any, findings: any[], sizeProfile?: PrSizeProfile): string {
  const pass = pr.rating != null && pr.rating >= 8;
  let out = `## PR ${pr.sourceBranch} — "${pr.title}"\n**Rating: ${pr.rating ?? "?"}/10** — ${pr.rating != null ? (pass ? "PASS" : "FAIL") : "Not yet"}\n\n`;
  if (sizeProfile) {
    out += `**Size:** ${formatSizeProfile(sizeProfile)}\n\n`;
  }
  if (findings.length === 0) {
    out += "No findings.\n";
  } else {
    for (const f of findings) {
      const confPct = ((f.confidence ?? 0.5) * 100).toFixed(0);
      out += `### ${f.filename}:${f.line}\n**[${f.category}|${f.severity}${f.exploitability ? `|${f.exploitability}` : ""}]** (confidence: ${confPct}%${f.confidenceReason ? ` — ${f.confidenceReason}` : ""}${f.impact ? `, impact: ${f.impact}` : ""})\n${f.explanation}\n`;
      if (f.diffSuggestion) {
        out += `Suggested fix:\n\`\`\`diff\n${f.diffSuggestion}\n\`\`\`\n`;
      }
      out += "\n";
    }
  }
  return out;
}

async function formatLatestFindings(pr: any): Promise<string> {
  const latest = await getLatestCompletedReview(pr.id);
  const displayPr = {
    ...pr,
    rating: latest.reviewRun?.rating ?? pr.rating,
  };
  const sizeProfile = await loadPrSizeProfile(pr);
  let out = formatFindings(displayPr, latest.findings, sizeProfile);
  if (!latest.reviewRun) {
    out += "\n_No completed ReviewRun yet._\n";
  } else {
    out += `\n_Reviewed commit ${latest.reviewRun.commitHash.slice(0, 7)}${latest.stale ? " (stale)" : ""}._\n`;
    if (latest.rejectedCount > 0) {
      out += `_Verifier filtered ${latest.rejectedCount} finding${latest.rejectedCount === 1 ? "" : "s"}._\n`;
    }
    if (latest.regressions.length > 0) {
      out += `_Regressions detected: ${latest.regressions.length} finding${latest.regressions.length === 1 ? "" : "s"} previously resolved but now reappeared._\n`;
      for (const r of latest.regressions) {
        out += `  ⚠ [${r.category}|${r.severity}] ${r.filename}:${r.line} — ${r.explanation}\n`;
      }
    }
    if (latest.reviewRun.refused) {
      out += `\n> ⚠ **Reviewer flagged incomplete coverage.** ${latest.reviewRun.refusalNote ?? "Parts of the PR were skipped or not fully analyzed."} Re-scan recommended after addressing the underlying cause.\n`;
    }
  }
  return out;
}

async function handlePrCheck(args: any, userId: string | null): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.\n>\n> To review a PR, create a feature branch and push it, or check available PRs with \`prlist\`.`;

  if (isReviewActive(pr.id)) return `> Review already in progress for **${pr.sourceBranch}**. Check results with \`prcheckstatus ${pr.sourceBranch}\` or view in dashboard.`;

  const repo = await prisma.repository.findUnique({ where: { id: pr.repoId } });
  if (!repo) {
    return `> ⚠ Repository for PR \`${pr.sourceBranch}\` could not be loaded.`;
  }

  const freshness = await assertIndexFresh(repo);
  if (freshness.ok === false) {
    if (freshness.kind === "INDEX_REQUIRED") {
      return `> ⚠ **Index required.** ${freshness.message}`;
    }
    // STALE_INDEX — auto-trigger incremental index
    if (repo.path) {
      await IndexingService.indexFolder(pr.repoId, repo.path);
    }
  }

  const started = await startTrackedReview(pr, repo, userId);
  if ("conflict" in started) {
    return `> ⚠ **Scan already in progress** for PR \`${pr.sourceBranch}\` (started ${started.startedAt.toISOString()}). Re-run \`prcheck ${pr.sourceBranch}\` after it completes.`;
  }

  return `> **Review started** for PR \`${started.sourceBranch}\`.\n>\n> Size: ${formatSizeProfile(started.sizeProfile)}\n>\n> This runs in the background. Check results with \`prcheckstatus ${started.sourceBranch}\` or view in the Dragnet dashboard.\n>\n> Alternatively, use \`prcomments ${started.sourceBranch}\` for the latest persisted findings.`;
}

async function handlePrCheckStatus(args: any, _userId: string | null): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.`;

  if (isReviewActive(pr.id)) return `> Review still in progress for **${pr.sourceBranch}**... Check back soon or view dashboard.`;

  // Re-fetch the PR so the rating reflects any async update from runPrScan.
  // Without this, `pr` carries the rating it had when first resolved —
  // a TOCTOU window where the review just finished but the stale rating
  // (null or old) is what gets formatted.
  const freshPr = await prisma.pullRequest.findUnique({ where: { id: pr.id } });
  if (!freshPr) return `> **No pull requests found** matching that criteria on this repository.`;

  const latest = await getLatestCompletedReview(pr.id);
  const displayPr = {
    ...pr,
    rating: latest.reviewRun?.rating ?? pr.rating,
  };
  const sizeProfile = await loadPrSizeProfile(pr);
  let out = formatFindings(displayPr, latest.findings, sizeProfile);
  if (latest.regressions.length > 0) {
    out += `\n## Regressions (reappeared findings)\n\n`;
    out += `The following findings were previously resolved but have reappeared:\n\n`;
    for (const f of latest.regressions) {
      const confPct = ((f.confidence ?? 0.5) * 100).toFixed(0);
      out += `### ${f.filename}:${f.line}\n**[${f.category}|${f.severity}${f.exploitability ? `|${f.exploitability}` : ""}]** (confidence: ${confPct}%${f.confidenceReason ? ` — ${f.confidenceReason}` : ""}${f.impact ? `, impact: ${f.impact}` : ""})\n${f.explanation}\n`;
      if (f.diffSuggestion) {
        out += `Suggested fix:\n\`\`\`diff\n${f.diffSuggestion}\n\`\`\`\n`;
      }
      out += "\n";
    }
  }
  if (!latest.reviewRun) {
    out += "\n_No completed ReviewRun yet._\n";
  } else {
    out += `\n_Reviewed commit ${latest.reviewRun.commitHash.slice(0, 7)}${latest.stale ? " (stale)" : ""}._\n`;
    if (latest.rejectedCount > 0) {
      out += `_Verifier filtered ${latest.rejectedCount} finding${latest.rejectedCount === 1 ? "" : "s"}._\n`;
    }
    if (latest.reviewRun.refused) {
      out += `\n> ⚠ **Reviewer flagged incomplete coverage.** ${latest.reviewRun.refusalNote ?? "Parts of the PR were skipped or not fully analyzed."} Re-scan recommended after addressing the underlying cause.\n`;
    }
  }
  return out;
}

async function handlePrComments(args: any, _userId: string | null): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.`;
  const latest = await getLatestCompletedReview(pr.id);
  if (!latest.reviewRun) return "No completed review for this PR.";
  const sizeProfile = await loadPrSizeProfile(pr);
  const findings = latest.findings;
  if (findings.length === 0) return `No findings for this PR.\nSize: ${formatSizeProfile(sizeProfile)}${latest.rejectedCount > 0 ? `\nVerifier filtered ${latest.rejectedCount}.` : ""}`;
  let out = `## Findings for PR ${pr.sourceBranch}\n\n`;
  out += `_Reviewed commit ${latest.reviewRun.commitHash.slice(0, 7)}${latest.stale ? " (stale)" : ""}._\n\n`;
  out += `**Size:** ${formatSizeProfile(sizeProfile)}\n\n`;
  for (const f of findings) {
    out += `- [${f.category}|${f.severity}${f.exploitability ? `|${f.exploitability}` : ""}] ${f.filename}:${f.line}\n  ${f.explanation}\n`;
  }
  if (latest.rejectedCount > 0) {
    out += `\n_Verifier filtered ${latest.rejectedCount} finding${latest.rejectedCount === 1 ? "" : "s"}._\n`;
  }
  return out;
}

/**
 * Shared prlist builder — single source of truth for both the JSON-RPC
 * `prlist` tool and the legacy `prlist` command. Pulls PRs + scan status,
 * computes stack topology, attaches per-PR `stackDepth` / `dependencies`
 * / `unscannedDepsCount` so callers (web UI, CLI, /dragnet merge skill)
 * get the same stack-aware view without recomputing client-side.
 *
 * Topology is advisory: callers verifying merge safety MUST re-check
 * live `gh pr view` state at execution time (mergeable/CI/reviews drift
 * in real time). Dragnet's snapshot is the starting point, not truth.
 */
async function buildPrList(repoId: string) {
  const prs = await prisma.pullRequest.findMany({
    where: { repoId }, orderBy: { createdAt: "desc" }, take: 20,
  });
  if (prs.length === 0) return { prs: [], topology: new Map(), scannedPrIds: new Set<string>() };

  const scanned = await prisma.reviewRun.findMany({
    where: { repoId, status: "completed" },
    select: { prId: true },
    distinct: ["prId"],
  });
  const scannedPrIds = new Set(scanned.map((s) => s.prId));

  const topoInputs: PrTopologyInput[] = prs.map((p) => ({
    id: p.id,
    sourceBranch: p.sourceBranch,
    targetBranch: p.targetBranch,
    rating: p.rating,
  }));
  const topology = computeStackTopology(topoInputs, scannedPrIds);

  return { prs, topology, scannedPrIds };
}

async function handlePrList(args: any, _userId: string | null): Promise<string> {
  if (!args.repoId) return 'Pass "repoId" to list PRs.';
  const { prs, topology } = await buildPrList(args.repoId);
  if (prs.length === 0) return "> **No pull requests found** for this repo.";

  let out = `## Pull Requests\n\n`;
  for (const p of prs) {
    const sizeProfile = await loadPrSizeProfile(p);
    const topo = topology.get(p.id);
    const rating = p.rating != null ? `${p.rating}/10` : "Not scanned";
    const stackInfo = topo
      ? ` — Stack: depth=${topo.stackDepth}${topo.unscannedDepsCount > 0 ? `, unscanned deps: ${topo.unscannedDepsCount}` : ""}`
      : "";
    out += `- **${p.sourceBranch}** — ${p.title} — ${rating} — ${formatSizeProfile(sizeProfile)}${stackInfo}\n`;
  }
  return out;
}

type Handler = (args: any, userId: string | null) => Promise<string>;
const toolHandlers: Record<string, Handler> = {
  prcheck: handlePrCheck,
  prcheckstatus: handlePrCheckStatus,
  prcomments: handlePrComments,
  prlist: handlePrList,
};

export function GET() {
  return NextResponse.json({ ok: true, message: "Dragnet API — use POST for JSON-RPC" });
}

export async function POST(req: Request, { params }: { params: Promise<{ args?: string[] }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: auth.error } }, { status: 401 });
  }

  const { args } = await params;
  const defRepo = defaultRepoId(req.url, args);
  const body = await req.json().catch(() => null);

  if (body && body.jsonrpc && body.method) {
    return handleJsonRpc(body, defRepo, auth.userId);
  }
  return handleLegacyCommand(body, defRepo, auth.userId);
}

async function handleJsonRpc(body: any, defRepo: string | null, userId: string | null) {
  const { method, id, params } = body;
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  if (method === "initialize") {
    return NextResponse.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bughunter", version: "1.0.0" },
      },
    });
  }

  if (method === "tools/list") {
    return NextResponse.json({ jsonrpc: "2.0", id, result: { tools: toolsWithRepo(defRepo) } });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = withDefaultRepo(params?.arguments ?? {}, defRepo);
    if (!toolName || !toolHandlers[toolName]) {
      return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
    }
    const result = await toolHandlers[toolName](args, userId);
    return NextResponse.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } });
  }

  return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

async function resolvePr(body: any, argVal: string): Promise<any | null> {
  let pr: any = null;
  if (argVal) pr = await findPrByIdOrNumber(argVal, body.repoId);
  if (pr && body.repoId && pr.repoId !== body.repoId) pr = null;
  if (!pr && body.repoId && body.branch) pr = await findPrByBranch(body.repoId, body.branch);
  return pr;
}

async function handleLegacyCommand(body: any, defRepo: string | null, userId: string | null) {
  const { command } = body || {};
  if (!command || typeof command !== "string") {
    return NextResponse.json({ status: "Error", message: "Send a command." }, { status: 400 });
  }
  const parts = command.trim().split(/\s+/);
  const cmdName = parts[0];
  const argVal = parts.slice(1).join(" ");

  try {
    if (cmdName.endsWith("prcheck") || cmdName.endsWith("checkpr")) {
      const pr = await resolvePr({ ...body, repoId: body.repoId || defRepo }, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "> No PR found on this repository." });
      if (isReviewActive(pr.id)) {
        return NextResponse.json({
          status: "Accepted", message: `> Review already in progress for **${pr.sourceBranch}**. Poll with prcheckstatus.`,
        });
      }
      const repo = await prisma.repository.findUnique({
        where: { id: pr.repoId },
      });
      if (!repo) {
        return NextResponse.json({
          status: "Error",
          message: `> Repository for PR \`${pr.sourceBranch}\` could not be loaded.`,
        });
      }
const freshness = await assertIndexFresh(repo);
      if (freshness.ok === false) {
        if (freshness.kind === "INDEX_REQUIRED") {
          return NextResponse.json({
            status: "Error",
            message: `> ⚠ **Index required.** ${freshness.message}`,
          });
        }
        // STALE_INDEX — auto-trigger incremental index inline so /dragnet fix
        // --auto loops don't dead-end after each fix commit advances HEAD.
        // Matches the behavior in handlePrCheck (JSON-RPC tool path).
        if (repo.path) {
          await IndexingService.indexFolder(pr.repoId, repo.path);
        }
      }
const started = await startTrackedReview(pr, repo, userId);
      if ("conflict" in started) {
        return NextResponse.json({
          status: "Conflict",
          message: `> ⚠ **Scan already in progress** for \`${pr.sourceBranch}\` (started ${started.startedAt.toISOString()}). Poll with \`prcheckstatus ${pr.sourceBranch}\`.`,
        }, { status: 409 });
      }
      return NextResponse.json({
        status: "Accepted",
        message: `> **Review started** for \`${started.sourceBranch}\`.\n>\n> Size: ${formatSizeProfile(started.sizeProfile)}\n>\n> Poll with \`prcheckstatus ${started.sourceBranch}\`.`,
        sizeProfile: started.sizeProfile,
      });
    }
    if (cmdName.endsWith("prcomments") || cmdName.endsWith("comments")) {
      const pr = await resolvePr({ ...body, repoId: body.repoId || defRepo }, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "> No PR found on this repository." });
      const latest = await getLatestCompletedReview(pr.id);
      const sizeProfile = await loadPrSizeProfile(pr);
      return NextResponse.json({
        status: "Success", type: "comments",
        productionScore: latest.reviewRun?.rating != null ? `${latest.reviewRun.rating}/10` : "Not Scanned Yet",
        reviewRun: latest.reviewRun,
        stale: latest.stale,
        rejectedCount: latest.rejectedCount,
        sizeProfile,
        comments: latest.findings.map((f: any) => `[${f.category} | ${f.severity}${f.exploitability ? ` | ${f.exploitability}` : ""}] ${f.filename}:${f.line} - ${f.explanation}`),
      });
    }
    if (cmdName.endsWith("prcheckstatus") || cmdName.endsWith("status")) {
      const pr = await resolvePr({ ...body, repoId: body.repoId || defRepo }, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "> No PR found on this repository." });
      const sizeProfile = await loadPrSizeProfile(pr);
      if (isReviewActive(pr.id)) {
        // Surface live progress: chunk completion + current agentic-loop round.
        // getActiveScan returns iterationsByChunk keyed by chunkId (or "__run"
        // for non-chunked scans). Flatten to a single "current round" summary.
        const active = await getActiveScan(pr.id);
        const run = active.reviewRun;
        const chunkIds = Object.keys(active.iterationsByChunk);
        const currentIter = chunkIds.length
          ? Math.max(...chunkIds.map((k) => active.iterationsByChunk[k].current))
          : 0;
        const maxIter = chunkIds.length
          ? Math.max(...chunkIds.map((k) => active.iterationsByChunk[k].max))
          : 0;
        return NextResponse.json({
          status: "Scanning",
          message: `> Scan in progress for **${pr.sourceBranch}**...`,
          sizeProfile,
          progress: run && {
            chunksCompleted: run.chunksCompleted,
            chunksTotal: run.chunksTotal,
            chunksFailed: run.chunksFailed,
            chunksSkipped: run.chunksSkipped,
            iteration: currentIter,
            maxIterations: maxIter,
            partialFindingsCount: active.findings.length,
            startedAt: run.startedAt,
          },
        });
      }
      // Re-fetch so we pick up any rating update from the async runPrScan.
      const freshPr = await prisma.pullRequest.findUnique({ where: { id: pr.id } });
      const latest = await getLatestCompletedReview(pr.id);
      const ratingTrend = await getRecentRuns(pr.id, 5);
      const stability = computeStability(ratingTrend);
      const weighted = computeWeightedStability(ratingTrend, lookupTrustWeight);
      return NextResponse.json({
        status: latest.reviewRun ? "Success" : (freshPr?.rating != null ? "Success" : "Pending"),
        type: "status",
        productionScore: latest.reviewRun?.rating != null ? `${latest.reviewRun.rating}/10` : (freshPr?.rating != null ? `${freshPr.rating}/10` : "Not scanned yet"),
        reviewRun: latest.reviewRun,
        ratingTrend,
        stability,
        weightedStability: weighted.weightedStability,
        weightedReadyToMerge: weighted.readyToMerge,
        stale: latest.stale,
        rejectedCount: latest.rejectedCount,
        regressionsCount: latest.regressions.length,
        regressions: latest.regressions.map((r: any) =>
          `[${r.category} | ${r.severity}] ${r.filename}:${r.line} - ${r.explanation} (regressed from ${r.regressedFromRunId ?? "unknown"})`,
        ),
        sizeProfile,
        findingsCount: latest.findings.filter((f: any) => f.status !== "resolved").length,
        findings: latest.findings
          .filter((f: any) => f.status !== "resolved")
          .map((f: any) =>
            `[${f.category} | ${f.severity}${f.exploitability ? ` | ${f.exploitability}` : ""}] ${f.filename}:${f.line} - ${f.explanation}`,
          ),
      });
    }
    if (cmdName.endsWith("prlist") || cmdName.endsWith("list")) {
      const rid = body.repoId || defRepo;
      if (!rid) return NextResponse.json({ status: "Error", message: "Pass { repoId }." }, { status: 400 });
      const { prs, topology } = await buildPrList(rid);
      const pullRequests = await Promise.all(prs.map(async (p) => {
        const sizeProfile = await loadPrSizeProfile(p);
        const topo = topology.get(p.id);
        return {
          number: p.sourceBranch, id: p.id, title: p.title,
          branch: p.sourceBranch, rating: p.rating != null ? `${p.rating}/10` : "Not scanned",
          sizeProfile,
          stackDepth: topo?.stackDepth ?? 0,
          dependencies: topo?.dependencies ?? [],
          unscannedDepsCount: topo?.unscannedDepsCount ?? 0,
        };
      }));
      return NextResponse.json({
        status: "Success", type: "list", repoId: rid,
        pullRequests,
      });
    }
    return NextResponse.json({ status: "Error", message: `Unknown command: ${cmdName}` }, { status: 400 });
  } catch (err: any) {
    console.error("[api error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
