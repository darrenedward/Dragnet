import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber, findPrByBranch } from "@/src/lib/findPr";
import { refreshPrFiles } from "@/src/lib/getRealLocalPrs";
import { runPrScan } from "@/reviewService";
import { refreshPrFiles } from "@/src/lib/getRealLocalPrs";
import { authenticateMcpRequest } from "@/src/lib/mcpAuth";

function defaultRepoId(url: string, args?: string[]): string | null {
  if (args && args.length > 0) return args[0];
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length >= 5 && parts[0] === "api" && parts[1] === "mcp" && parts[2] === "command") {
      return parts[4] || null;
    }
  } catch {}
  return null;
}

function withDefaultRepo(args: any, defRepo: string | null): any {
  if (defRepo && !args.repoId) return { ...args, repoId: defRepo };
  return args;
}

const activeReviews = new Set<string>();

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
  let pr = args.number ? await findPrByIdOrNumber(args.number) : null;
  if (pr && args.repoId && pr.repoId !== args.repoId) pr = null;
  if (!pr && args.repoId && args.branch) pr = await findPrByBranch(args.repoId, args.branch);
  return pr;
}

<<<<<<< HEAD
function formatFindings(pr: any, findings: any[]): string {
  const pass = pr.rating != null && pr.rating >= 4;
  let out = `## PR ${pr.sourceBranch} — "${pr.title}"\n**Rating: ${pr.rating ?? "?"}/5** — ${pr.rating != null ? (pass ? "PASS" : "FAIL") : "Not yet"}\n\n`;
  if (findings.length === 0) {
=======
  try {
    const repo = await prisma.repository.findUnique({ where: { id: pr.repoId } });
    if (repo) {
      await refreshPrFiles(repo.path, repo.baseBranch, pr.sourceBranch, pr.id);
    }
  } catch (e) {
    console.warn("[mcp] prfile refresh failed, using cached:", e);
  }

  const sr = await runPrScan(pr.id);
  const pass = sr.rating >= 4;
  let out = `## PR #${pr.id} — "${pr.title}"\n**Rating: ${sr.rating}/5** — ${pass ? "PASS" : "FAIL"}\n\n`;
  if (sr.findings.length === 0) {
>>>>>>> a39c4b6 (test: add comment for review loop demo)
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

async function handlePrCheck(args: any): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.\n>\n> To review a PR, create a feature branch and push it, or check available PRs with \`prlist\`.`;

  if (activeReviews.has(pr.id)) return `> Review already in progress for **${pr.sourceBranch}**. Check results with \`prcheckstatus ${pr.sourceBranch}\` or view in dashboard.`;

  try {
    const repo = await prisma.repository.findUnique({ where: { id: pr.repoId } });
    if (repo) {
      await refreshPrFiles(repo.path, repo.baseBranch, pr.sourceBranch, pr.id);
    }
  } catch (e) {
    console.warn("[mcp] prfile refresh failed, using cached:", e);
  }

  activeReviews.add(pr.id);
  runPrScan(pr.id).then((sr) => {
    activeReviews.delete(pr.id);
    prisma.pullRequest.updateMany({ where: { id: pr.id }, data: { rating: sr.rating } }).catch(() => {});
    console.log(`[mcp] review complete for ${pr.sourceBranch}: ${sr.rating}/5`);
  }).catch((err) => {
    activeReviews.delete(pr.id);
    console.error(`[mcp] review failed for ${pr.sourceBranch}:`, err);
  });

  return `> **Review started** for PR \`${pr.sourceBranch}\`.\n>\n> This runs in the background. Check results with \`prcheckstatus ${pr.sourceBranch}\` or view in the GrepLoop dashboard.\n>\n> Alternatively, use \`prcomments ${pr.sourceBranch}\` for the latest persisted findings.`;
}

async function handlePrCheckStatus(args: any): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.`;

  if (activeReviews.has(pr.id)) return `> Review still in progress for **${pr.sourceBranch}**... Check back soon or view dashboard.`;

  const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id }, orderBy: { line: "asc" } });
  return formatFindings(pr, findings);
}

async function handlePrComments(args: any): Promise<string> {
  const pr = await resolvePrFromArgs(args);
  if (!pr) return `> **No pull requests found** matching that criteria on this repository.`;
  const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id }, orderBy: { line: "asc" } });
  if (findings.length === 0) return "No findings for this PR.";
  let out = `## Findings for PR ${pr.sourceBranch}\n\n`;
  for (const f of findings) {
    out += `- [${f.category}|${f.severity}] ${f.filename}:${f.line}\n  ${f.explanation}\n`;
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
    out += `- **${p.sourceBranch}** — ${p.title} — ${p.rating != null ? `${p.rating}/5` : "Not scanned"}\n`;
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
  return NextResponse.json({ ok: true, message: "bughunter MCP server — use POST for JSON-RPC" });
}

export async function POST(req: Request, { params }: { params: Promise<{ args?: string[] }> }) {
  const auth = await authenticateMcpRequest(req);
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
  if (argVal) pr = await findPrByIdOrNumber(argVal);
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
      const sr = await runPrScan(pr.id);
      return NextResponse.json({
        status: "Success", type: "check", rating: `${sr.rating}/5`,
        productionGrade: sr.rating >= 4 ? "YES" : "NO",
        findingsCount: sr.findings.length,
        findings: sr.findings.map((f: any) => `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`),
      });
    }
    if (cmdName.endsWith("prcomments") || cmdName.endsWith("comments")) {
      const pr = await resolvePr({ ...body, repoId: body.repoId || defRepo }, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "> No PR found on this repository." });
      const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
      return NextResponse.json({
        status: "Success", type: "comments",
        productionScore: pr.rating ? `${pr.rating}/5` : "Not Scanned Yet",
        comments: findings.map((f: any) => `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`),
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
          branch: p.sourceBranch, rating: p.rating != null ? `${p.rating}/5` : "Not scanned",
        })),
      });
    }
    return NextResponse.json({ status: "Error", message: `Unknown command: ${cmdName}` }, { status: 400 });
  } catch (err: any) {
    console.error("[MCP error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
