import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber, findPrByBranch } from "@/src/lib/findPr";
import { refreshPrFiles } from "@/src/lib/getRealLocalPrs";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/reviewService";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { isReviewActive, beginReview, endReview } from "@/src/lib/reviewLocks";
import { getChatChain } from "@/src/lib/llmClient";
import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
  assertNoActiveScan,
  createReviewRun,
  getLatestCompletedReview,
} from "@/src/lib/reviewFreshness";

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
async function startTrackedReview(pr: any, repo: any): Promise<
  | { sourceBranch: string }
  | { conflict: true; runId: string; startedAt: Date }
> {
  const chatChain = getChatChain();
  let files: any[] = [];
  if (repo?.path && pr.sourceBranch) {
    try {
      files = await refreshPrFiles(repo.path, repo.baseBranch || "main", pr.sourceBranch, pr.id);
    } catch (e) {
      console.warn("[api] prfile refresh failed, using cached:", e);
    }
  }
  const diffHash = computeDiffHash(files);
  const configHash = chatChain.length > 0
    ? computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION))
    : "";

  // Concurrency guard — the /gloop skill may invoke prcheck while a
  // UI-triggered scan is still running. Reject the duplicate scan.
  const activeScan = await assertNoActiveScan(pr.id, false);
  if (activeScan.ok === false) {
    return {
      conflict: true,
      runId: activeScan.runId,
      startedAt: activeScan.startedAt,
    };
  }

  const reviewRunId = await createReviewRun({
    prId: pr.id,
    repoId: pr.repoId,
    commitHash: pr.commitHash,
    diffHash,
    reviewConfigHash: configHash,
    model: chatChain[0]?.model ?? null,
    triggerReason: "prcheck",
  });

  beginReview(pr.id);
  runPrScan(pr.id, files, reviewRunId).then((sr) => {
    endReview(pr.id);
    prisma.pullRequest.updateMany({ where: { id: pr.id }, data: { rating: sr.rating } }).catch(() => {});
    console.log(`[api] review complete for ${pr.sourceBranch}: ${sr.rating}/10`);
  }).catch((err) => {
    endReview(pr.id);
    console.error(`[api] review failed for ${pr.sourceBranch}:`, err);
  });

  return { sourceBranch: pr.sourceBranch };
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

function formatFindings(pr: any, findings: any[]): string {
  const pass = pr.rating != null && pr.rating >= 8;
  let out = `## PR ${pr.sourceBranch} — "${pr.title}"\n**Rating: ${pr.rating ?? "?"}/10** — ${pr.rating != null ? (pass ? "PASS" : "FAIL") : "Not yet"}\n\n`;
  if (findings.length === 0) {
    out += "No findings.\n";
  } else {
    for (const f of findings) {
      out += `### ${f.filename}:${f.line}\n**[${f.category}|${f.severity}]** (confidence: ${((f.confidence ?? 0.5) * 100).toFixed(0)}%)\n${f.explanation}\n`;
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
  let out = formatFindings(displayPr, latest.findings);
  if (!latest.reviewRun) {
    out += "\n_No completed ReviewRun yet._\n";
  } else {
    out += `\n_Reviewed commit ${latest.reviewRun.commitHash.slice(0, 7)}${latest.stale ? " (stale)" : ""}._\n`;
    if (latest.rejectedCount > 0) {
      out += `_Verifier filtered ${latest.rejectedCount} finding${latest.rejectedCount === 1 ? "" : "s"}._\n`;
    }
  }
  return out;
}

async function handlePrCheck(args: any): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.\n>\n> To review a PR, create a feature branch and push it, or check available PRs with \`prlist\`.`;

  if (isReviewActive(pr.id)) return `> Review already in progress for **${pr.sourceBranch}**. Check results with \`prcheckstatus ${pr.sourceBranch}\` or view in dashboard.`;

  const repo = await prisma.repository.findUnique({ where: { id: pr.repoId } });
  if (!repo) {
    return `> ⚠ Repository for PR \`${pr.sourceBranch}\` could not be loaded.`;
  }

  const freshness = assertIndexFresh(repo);
  if (freshness.ok === false) {
    if (freshness.kind === "INDEX_REQUIRED") {
      return `> ⚠ **Index required.** ${freshness.message}`;
    }
    // STALE_INDEX — auto-trigger incremental index
    if (repo.path) {
      await IndexingService.indexFolder(pr.repoId, repo.path);
    }
  }

  const started = await startTrackedReview(pr, repo);
  if ("conflict" in started) {
    return `> ⚠ **Scan already in progress** for PR \`${pr.sourceBranch}\` (started ${started.startedAt.toISOString()}). Re-run \`prcheck ${pr.sourceBranch}\` after it completes.`;
  }

  return `> **Review started** for PR \`${started.sourceBranch}\`.\n>\n> This runs in the background. Check results with \`prcheckstatus ${started.sourceBranch}\` or view in the GrepLoop dashboard.\n>\n> Alternatively, use \`prcomments ${started.sourceBranch}\` for the latest persisted findings.`;
}

async function handlePrCheckStatus(args: any): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.`;

  if (isReviewActive(pr.id)) return `> Review still in progress for **${pr.sourceBranch}**... Check back soon or view dashboard.`;

  // Re-fetch the PR so the rating reflects any async update from runPrScan.
  // Without this, `pr` carries the rating it had when first resolved —
  // a TOCTOU window where the review just finished but the stale rating
  // (null or old) is what gets formatted.
  const freshPr = await prisma.pullRequest.findUnique({ where: { id: pr.id } });
  if (!freshPr) return `> **No pull requests found** matching that criteria on this repository.`;

  return formatLatestFindings(freshPr);
}

async function handlePrComments(args: any): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.`;
  const latest = await getLatestCompletedReview(pr.id);
  if (!latest.reviewRun) return "No completed review for this PR.";
  const findings = latest.findings;
  if (findings.length === 0) return `No findings for this PR.${latest.rejectedCount > 0 ? ` Verifier filtered ${latest.rejectedCount}.` : ""}`;
  let out = `## Findings for PR ${pr.sourceBranch}\n\n`;
  out += `_Reviewed commit ${latest.reviewRun.commitHash.slice(0, 7)}${latest.stale ? " (stale)" : ""}._\n\n`;
  for (const f of findings) {
    out += `- [${f.category}|${f.severity}] ${f.filename}:${f.line}\n  ${f.explanation}\n`;
  }
  if (latest.rejectedCount > 0) {
    out += `\n_Verifier filtered ${latest.rejectedCount} finding${latest.rejectedCount === 1 ? "" : "s"}._\n`;
  }
  return out;
}

async function handlePrList(args: any): Promise<string> {
  if (!args.repoId) return 'Pass "repoId" to list PRs.';
  const prs = await prisma.pullRequest.findMany({
    where: { repoId: args.repoId }, orderBy: { createdAt: "desc" }, take: 20,
  });
  if (prs.length === 0) return "> **No pull requests found** for this repo.";
  let out = `## Pull Requests\n\n`;
  for (const p of prs) {
    out += `- **${p.sourceBranch}** — ${p.title} — ${p.rating != null ? `${p.rating}/10` : "Not scanned"}\n`;
  }
  return out;
}

type Handler = (args: any) => Promise<string>;
const toolHandlers: Record<string, Handler> = {
  prcheck: handlePrCheck,
  prcheckstatus: handlePrCheckStatus,
  prcomments: handlePrComments,
  prlist: handlePrList,
};

export function GET() {
  return NextResponse.json({ ok: true, message: "GrepLoop API — use POST for JSON-RPC" });
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
    return handleJsonRpc(body, defRepo);
  }
  return handleLegacyCommand(body, defRepo);
}

async function handleJsonRpc(body: any, defRepo: string | null) {
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
    const result = await toolHandlers[toolName](args);
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

async function handleLegacyCommand(body: any, defRepo: string | null) {
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
      const freshness = assertIndexFresh(repo);
      if (freshness.ok === false) {
        return NextResponse.json({
          status: "Error",
          message: `> ⚠ **${freshness.kind === "INDEX_REQUIRED" ? "Index required" : "Stale index"}.** ${freshness.message}`,
        });
      }
      const started = await startTrackedReview(pr, repo);
      if ("conflict" in started) {
        return NextResponse.json({
          status: "Conflict",
          message: `> ⚠ **Scan already in progress** for \`${pr.sourceBranch}\` (started ${started.startedAt.toISOString()}). Poll with \`prcheckstatus ${pr.sourceBranch}\`.`,
        }, { status: 409 });
      }
      return NextResponse.json({
        status: "Accepted",
        message: `> **Review started** for \`${started.sourceBranch}\`. Poll with \`prcheckstatus ${started.sourceBranch}\`.`,
      });
    }
    if (cmdName.endsWith("prcomments") || cmdName.endsWith("comments")) {
      const pr = await resolvePr({ ...body, repoId: body.repoId || defRepo }, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "> No PR found on this repository." });
      const latest = await getLatestCompletedReview(pr.id);
      return NextResponse.json({
        status: "Success", type: "comments",
        productionScore: latest.reviewRun?.rating != null ? `${latest.reviewRun.rating}/10` : "Not Scanned Yet",
        reviewRun: latest.reviewRun,
        stale: latest.stale,
        rejectedCount: latest.rejectedCount,
        comments: latest.findings.map((f: any) => `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`),
      });
    }
    if (cmdName.endsWith("prcheckstatus") || cmdName.endsWith("status")) {
      const pr = await resolvePr({ ...body, repoId: body.repoId || defRepo }, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "> No PR found on this repository." });
      if (isReviewActive(pr.id)) {
        return NextResponse.json({
          status: "Pending",
          message: `> Review still in progress for **${pr.sourceBranch}**...`,
        });
      }
      // Re-fetch so we pick up any rating update from the async runPrScan.
      const freshPr = await prisma.pullRequest.findUnique({ where: { id: pr.id } });
      const latest = await getLatestCompletedReview(pr.id);
      return NextResponse.json({
        status: latest.reviewRun ? "Success" : (freshPr?.rating != null ? "Success" : "Pending"),
        type: "status",
        productionScore: latest.reviewRun?.rating != null ? `${latest.reviewRun.rating}/10` : (freshPr?.rating != null ? `${freshPr.rating}/10` : "Not scanned yet"),
        reviewRun: latest.reviewRun,
        stale: latest.stale,
        rejectedCount: latest.rejectedCount,
        findingsCount: latest.findings.length,
        findings: latest.findings.map((f: any) =>
          `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`,
        ),
      });
    }
    if (cmdName.endsWith("prlist") || cmdName.endsWith("list")) {
      const rid = body.repoId || defRepo;
      if (!rid) return NextResponse.json({ status: "Error", message: "Pass { repoId }." }, { status: 400 });
      const prs = await prisma.pullRequest.findMany({
        where: { repoId: rid }, orderBy: { createdAt: "desc" }, take: 20,
      });
      return NextResponse.json({
        status: "Success", type: "list", repoId: rid,
        pullRequests: prs.map(p => ({
          number: p.sourceBranch, id: p.id, title: p.title,
          branch: p.sourceBranch, rating: p.rating != null ? `${p.rating}/10` : "Not scanned",
        })),
      });
    }
    return NextResponse.json({ status: "Error", message: `Unknown command: ${cmdName}` }, { status: 400 });
  } catch (err: any) {
    console.error("[api error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
