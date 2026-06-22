import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber, findPrByBranch } from "@/src/lib/findPr";
import { runPrScan } from "@/reviewService";
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

function toolsWithRepo(repo: string | null): any[] {
  const suffix = repo ? ` (repo: ${repo})` : "";
  return [
    {
      name: "prcheck",
      description: `Review a pull request. Pass number=PR_ID (e.g. "5"), or repoId+branch for branch-based lookup. Returns rating 1-5 and findings.${suffix}`,
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

async function handlePrCheck(args: any): Promise<string> {
  const pr = args.number
    ? await findPrByIdOrNumber(args.number)
    : args.repoId && args.branch
      ? await findPrByBranch(args.repoId, args.branch)
      : null;
  if (!pr) return `PR not found. Provide "number" or "repoId"+"branch".`;

  const sr = await runPrScan(pr.id);
  const pass = sr.rating >= 4;
  let out = `## PR #${pr.id} — "${pr.title}"\n**Rating: ${sr.rating}/5** — ${pass ? "PASS" : "FAIL"}\n\n`;
  if (sr.findings.length === 0) {
    out += "No findings.\n";
  } else {
    for (const f of sr.findings) {
      out += `- [${f.category}|${f.severity}] ${f.filename}:${f.line} (confidence: ${((f.confidence ?? 0.5) * 100).toFixed(0)}%)\n  ${f.explanation}\n`;
    }
  }
  return out;
}

async function handlePrComments(args: any): Promise<string> {
  const pr = args.number
    ? await findPrByIdOrNumber(args.number)
    : args.repoId && args.branch
      ? await findPrByBranch(args.repoId, args.branch)
      : null;
  if (!pr) return `PR not found. Provide "number" or "repoId"+"branch".`;
  const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
  if (findings.length === 0) return "No findings for this PR.";
  let out = `## Findings for PR #${pr.id}\n\n`;
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
  if (prs.length === 0) return "No PRs found for this repo.";
  let out = `## Pull Requests\n\n`;
  for (const p of prs) {
    out += `- **${p.sourceBranch}** — ${p.title} — ${p.rating != null ? `${p.rating}/5` : "Not scanned"}\n`;
  }
  return out;
}

type Handler = (args: any) => Promise<string>;
const toolHandlers: Record<string, Handler> = {
  prcheck: handlePrCheck,
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
  if (argVal) return findPrByIdOrNumber(argVal);
  if (body.repoId && body.branch) return findPrByBranch(body.repoId, body.branch);
  return null;
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
      if (!pr) return NextResponse.json({ status: "Error", message: "PR not found." });
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
      if (!pr) return NextResponse.json({ status: "Error", message: "PR not found." });
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
