import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber, findPrByBranch } from "@/src/lib/findPr";
import { refreshPrFiles } from "@/src/lib/getRealPrs";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/src/services/reviewService";
import { authenticateApiRequest, enforceRepoScope, type AuthResult } from "@/src/lib/apiAuth";
import { isReviewActive, acquireReviewLock } from "@/src/lib/reviewLocks";
import { blocksExplicitAdmit, runScanPrelude } from "@/src/lib/scanPrelude";
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
  getLatestTerminalReview,
  getRecentRuns,
  getActiveScan,
} from "@/src/lib/reviewFreshness";
import { computeStability, computeWeightedStability } from "@/src/lib/stabilityScore";
import { lookupTrustWeight } from "@/src/lib/modelTrustWeights";
import { isMergeReady } from "@/src/lib/isMergeReady";
import { admitScanJobForPr } from "@/src/services/scanQueue";
import {
  classifyScanTerminalOutcome,
  providerOutcomesFromTokensUsed,
} from "@/src/lib/scanTerminalOutcome";

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
  | { sourceBranch: string; jobId: string; queuePosition: number | null }
  | { conflict: true; runId: string; startedAt: Date }
> {
  const job = await admitScanJobForPr({
    prId: pr.id,
    triggerReason: "prcheck",
    kind: "explicit",
    createdByUserId: userId,
  });
  if (!job) throw new Error("Pull request disappeared before scan admission");
  return { sourceBranch: pr.sourceBranch, jobId: job.jobId, queuePosition: job.queuePosition };
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

function formatFindings(
  pr: any,
  findings: any[],
  sizeProfile?: PrSizeProfile,
  gate?: { mergeReady: boolean; mergeBlockReason: string | null },
): string {
  const resolved =
    gate ??
    isMergeReady({
      rating: pr.rating,
      outcome: pr.outcome ?? null,
      reliability: pr.reliability ?? null,
      refused: pr.refused ?? false,
      stale: pr.stale ?? null,
      staleReason: pr.staleReason ?? null,
      status: pr.status ?? null,
    });
  const verdict = pr.rating == null && !resolved.mergeReady
    ? "Not yet"
    : resolved.mergeReady
      ? "PASS"
      : "FAIL";
  let out = `## PR ${pr.sourceBranch} — "${pr.title}"\n**Rating: ${pr.rating ?? "?"}/10** — ${verdict}`;
  if (resolved.mergeReady) {
    out += " — Merge ready";
  } else if (resolved.mergeBlockReason) {
    out += ` — Not ready (${resolved.mergeBlockReason})`;
  }
  out += "\n\n";
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
  const run = latest.reviewRun;
  const gate = run
    ? isMergeReady({
        rating: run.rating,
        outcome: run.outcome,
        reliability: run.reliability,
        refused: run.refused,
        stale: latest.stale,
        staleReason: latest.staleReason,
        status: run.status,
      })
    : { mergeReady: false, mergeBlockReason: "No completed review yet" };
  const displayPr = {
    ...pr,
    rating: run?.rating ?? pr.rating,
    outcome: run?.outcome ?? null,
    reliability: run?.reliability ?? null,
    refused: run?.refused ?? false,
    stale: latest.stale,
    staleReason: latest.staleReason,
    status: run?.status ?? null,
  };
  const sizeProfile = await loadPrSizeProfile(pr);
  let out = formatFindings(displayPr, latest.findings, sizeProfile, gate);
  if (!run) {
    out += "\n_No completed ReviewRun yet._\n";
  } else {
    const staleTag = !latest.stale
      ? ""
      : latest.staleReason === "tip_mismatch"
        ? " (stale — tip mismatch)"
        : " (stale)";
    out += `\n_Reviewed commit ${run.commitHash.slice(0, 7)}${staleTag}._\n`;
    if (latest.rejectedCount > 0) {
      out += `_Verifier filtered ${latest.rejectedCount} finding${latest.rejectedCount === 1 ? "" : "s"}._\n`;
    }
    if (latest.regressions.length > 0) {
      out += `_Regressions detected: ${latest.regressions.length} finding${latest.regressions.length === 1 ? "" : "s"} previously resolved but now reappeared._\n`;
      for (const r of latest.regressions) {
        out += `  ⚠ [${r.category}|${r.severity}] ${r.filename}:${r.line} — ${r.explanation}\n`;
      }
    }
    if (run.refused) {
      out += `\n> ⚠ **Reviewer flagged incomplete coverage.** ${run.refusalNote ?? "Parts of the PR were skipped or not fully analyzed."} Re-scan recommended after addressing the underlying cause.\n`;
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

  // Explicit review always admits when gates pass; fail-fast on config/index
  // so /dragnet does not queue work known to fail. STALE volume repos
  // reindex via prelude (never no-op when only clone URL exists).
  const prelude = await runScanPrelude(repo);
  if (prelude.ok === false && blocksExplicitAdmit(prelude.gate)) {
    return `> ⚠ **Blocked at ${prelude.gate}.** ${prelude.message}`;
  }

  const started = await startTrackedReview(pr, repo, userId);
  if ("conflict" in started) {
    return `> ⚠ **Scan already in progress** for PR \`${pr.sourceBranch}\` (started ${started.startedAt.toISOString()}). Re-run \`prcheck ${pr.sourceBranch}\` after it completes.`;
  }

  return `> **Review queued** for PR \`${started.sourceBranch}\`.\n>\n> Queue job: \`${started.jobId}\` (position ${started.queuePosition ?? "running"}).\n>\n> This runs in the background. Check results with \`prcheckstatus ${started.sourceBranch}\` or view in the Dragnet dashboard.`;
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
  const run = latest.reviewRun;
  const gate = run
    ? isMergeReady({
        rating: run.rating,
        outcome: run.outcome,
        reliability: run.reliability,
        refused: run.refused,
        stale: latest.stale,
        staleReason: latest.staleReason,
        status: run.status,
      })
    : { mergeReady: false, mergeBlockReason: "No completed review yet" };
  const displayPr = {
    ...pr,
    rating: run?.rating ?? freshPr.rating ?? pr.rating,
    outcome: run?.outcome ?? null,
    reliability: run?.reliability ?? null,
    refused: run?.refused ?? false,
    stale: latest.stale,
    staleReason: latest.staleReason,
    status: run?.status ?? null,
  };
  const sizeProfile = await loadPrSizeProfile(pr);
  let out = formatFindings(displayPr, latest.findings, sizeProfile, gate);
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
  if (!run) {
    out += "\n_No completed ReviewRun yet._\n";
  } else {
    const staleTag = !latest.stale
      ? ""
      : latest.staleReason === "tip_mismatch"
        ? " (stale — tip mismatch)"
        : " (stale)";
    out += `\n_Reviewed commit ${run.commitHash.slice(0, 7)}${staleTag}._\n`;
    if (latest.rejectedCount > 0) {
      out += `_Verifier filtered ${latest.rejectedCount} finding${latest.rejectedCount === 1 ? "" : "s"}._\n`;
    }
    if (run.refused) {
      out += `\n> ⚠ **Reviewer flagged incomplete coverage.** ${run.refusalNote ?? "Parts of the PR were skipped or not fully analyzed."} Re-scan recommended after addressing the underlying cause.\n`;
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
  const commentsStaleTag = !latest.stale
    ? ""
    : latest.staleReason === "tip_mismatch"
      ? " (stale — tip mismatch)"
      : " (stale)";
  out += `_Reviewed commit ${latest.reviewRun.commitHash.slice(0, 7)}${commentsStaleTag}._\n\n`;
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
  // URL path / explicit args win; else per-repo API key scopes the project
  // so DRAGNET_REPO_ID is optional when the Bearer key is already repo-scoped.
  const defRepo = defaultRepoId(req.url, args) ?? auth.repoId ?? null;
  const body = await req.json().catch(() => null);

  if (body && body.jsonrpc && body.method) {
    return handleJsonRpc(body, defRepo, auth);
  }
  return handleLegacyCommand(body, defRepo, auth);
}

async function handleJsonRpc(body: any, defRepo: string | null, auth: AuthResult) {
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
    if (args.repoId) {
      const scopeErr = enforceRepoScope(auth, args.repoId);
      if (scopeErr) {
        return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32003, message: scopeErr.error } }, { status: 403 });
      }
    }
    const result = await toolHandlers[toolName](args, auth.userId);
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

async function handleLegacyCommand(body: any, defRepo: string | null, auth: AuthResult) {
  const { command } = body || {};
  if (!command || typeof command !== "string") {
    return NextResponse.json({ status: "Error", message: "Send a command." }, { status: 400 });
  }
  const parts = command.trim().split(/\s+/);
  const cmdName = parts[0];
  const argVal = parts.slice(1).join(" ");
  const userId = auth.userId;

  try {
    if (cmdName.endsWith("prcheck") || cmdName.endsWith("checkpr")) {
      const rid = body.repoId || defRepo;
      if (rid) {
        const scopeErr = enforceRepoScope(auth, rid);
        if (scopeErr) return NextResponse.json({ status: "Error", message: scopeErr.error }, { status: 403 });
      }
      const pr = await resolvePr({ ...body, repoId: rid }, argVal);
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
      const prelude = await runScanPrelude(repo);
      if (prelude.ok === false && blocksExplicitAdmit(prelude.gate)) {
        return NextResponse.json({
          status: "Error",
          message: `> ⚠ **Blocked at ${prelude.gate}.** ${prelude.message}`,
          gate: prelude.gate,
        });
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
        message: `> **Review queued** for \`${started.sourceBranch}\`.\n>\n> Queue job: \`${started.jobId}\` (position ${started.queuePosition ?? "running"}).\n>\n> Poll with \`prcheckstatus ${started.sourceBranch}\`.`,
        jobId: started.jobId,
        queuePosition: started.queuePosition,
      });
    }
    if (cmdName.endsWith("prcomments") || cmdName.endsWith("comments")) {
      const rid = body.repoId || defRepo;
      if (rid) {
        const scopeErr = enforceRepoScope(auth, rid);
        if (scopeErr) return NextResponse.json({ status: "Error", message: scopeErr.error }, { status: 403 });
      }
      const pr = await resolvePr({ ...body, repoId: rid }, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "> No PR found on this repository." });
      const latest = await getLatestCompletedReview(pr.id);
      const sizeProfile = await loadPrSizeProfile(pr);
      return NextResponse.json({
        status: "Success", type: "comments",
        productionScore: latest.reviewRun?.rating != null ? `${latest.reviewRun.rating}/10` : "Not Scanned Yet",
        reviewRun: latest.reviewRun,
        stale: latest.stale,
        staleReason: latest.staleReason,
        rejectedCount: latest.rejectedCount,
        sizeProfile,
        comments: latest.findings.map((f: any) => `[${f.category} | ${f.severity}${f.exploitability ? ` | ${f.exploitability}` : ""}] ${f.filename}:${f.line} - ${f.explanation}`),
      });
    }
    if (cmdName.endsWith("prcheckstatus") || cmdName.endsWith("status")) {
      const rid = body.repoId || defRepo;
      if (rid) {
        const scopeErr = enforceRepoScope(auth, rid);
        if (scopeErr) return NextResponse.json({ status: "Error", message: scopeErr.error }, { status: 403 });
      }
      const pr = await resolvePr({ ...body, repoId: rid }, argVal);
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
          outcomeClass: "processing",
          systemWarn: null,
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
      const terminal = await getLatestTerminalReview(pr.id);
      const ratingTrend = await getRecentRuns(pr.id, 5);
      const stability = computeStability(ratingTrend);
      const weighted = computeWeightedStability(ratingTrend, lookupTrustWeight);
      const terminalRun = terminal.reviewRun;
      const terminalOutcome = classifyScanTerminalOutcome({
        prStatus: freshPr?.status ?? pr.status,
        runStatus: terminalRun?.status ?? latest.reviewRun?.status,
        runOutcome: terminalRun?.outcome ?? latest.reviewRun?.outcome,
        rating: terminalRun?.rating ?? latest.reviewRun?.rating,
        systemWarn: terminalRun?.systemWarn ?? null,
        terminalClass: terminalRun?.terminalClass ?? null,
        providerOutcomes: providerOutcomesFromTokensUsed(
          terminalRun?.tokensUsed ?? latest.reviewRun?.tokensUsed,
        ),
      });
      const statusRunFailed = terminalRun?.status === "failed";
      const merge = isMergeReady(
        statusRunFailed
          ? { status: "failed", outcome: null, rating: null }
          : latest.reviewRun
            ? {
                status: latest.reviewRun.status,
                outcome: latest.reviewRun.outcome,
                rating: latest.reviewRun.rating,
                reliability: latest.reviewRun.reliability,
                refused: latest.reviewRun.refused,
                stale: latest.stale,
                staleReason: latest.staleReason,
              }
            : null,
      );
      const httpStatus = terminalOutcome.isFailed
        ? "Failed"
        : latest.reviewRun
          ? "Success"
          : freshPr?.rating != null
            ? "Success"
            : "Pending";
      return NextResponse.json({
        status: httpStatus,
        type: "status",
        productionScore:
          statusRunFailed
            ? "Failed"
            : latest.reviewRun?.rating != null
              ? `${latest.reviewRun.rating}/10`
              : freshPr?.rating != null
                ? `${freshPr.rating}/10`
                : "Not scanned yet",
        reviewRun: terminalRun ?? latest.reviewRun,
        /** Scan terminal outcome class + warn for /dragnet automation (issue #140). */
        outcomeClass: terminalOutcome.class,
        systemWarn: terminalOutcome.systemWarn ?? terminalRun?.systemWarn ?? null,
        terminalOutcome,
        ratingTrend,
        stability,
        weightedStability: weighted.weightedStability,
        weightedReadyToMerge: weighted.readyToMerge,
        /** Shared merge gate — same rule as prepush / findings / UI. Not rating-only. */
        mergeReady: merge.mergeReady,
        mergeBlockReason: merge.mergeBlockReason,
        mergeReadyMessage: merge.message,
        stale: latest.stale || terminal.stale,
        staleReason: latest.staleReason ?? terminal.staleReason,
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
      const scopeErr = enforceRepoScope(auth, rid);
      if (scopeErr) return NextResponse.json({ status: "Error", message: scopeErr.error }, { status: 403 });
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
