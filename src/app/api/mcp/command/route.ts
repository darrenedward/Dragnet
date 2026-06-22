import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber, findPrByBranch } from "@/src/lib/findPr";
import { runPrScan } from "@/reviewService";
import { authenticateMcpRequest } from "@/src/lib/mcpAuth";

async function resolvePr(body: any, cmdArg: string): Promise<any | null> {
  if (cmdArg) return findPrByIdOrNumber(cmdArg);
  if (body.repoId && body.branch) return findPrByBranch(body.repoId, body.branch);
  return null;
}

export async function POST(req: Request) {
  const auth = await authenticateMcpRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ status: "Error", message: auth.error }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as any));
  const { command } = body;
  if (!command || typeof command !== "string") {
    return NextResponse.json({
      status: "Error",
      message: "Send a command with optional repoId+branch. Examples:\n- '/prcheck 2'\n- '/prcheck' with { repoId: 'my-repo', branch: 'feature/xyz' }"
    }, { status: 400 });
  }

  const cleanCommand = command.trim();
  const parts = cleanCommand.split(/\s+/);
  const cmdName = parts[0];
  const argVal = parts.slice(1).join(" ");

  try {
    if (cmdName === "/prcheck" || cmdName === "/checkpr" || cmdName === "checkpr" || cmdName === "prcheck") {
      const pr = await resolvePr(body, argVal);
      if (!pr) {
        return NextResponse.json({
          status: "Error",
          message: argVal
            ? `Pull Request for "${argVal}" not found.`
            : "No PR specified and no branch match. Provide a PR number, or pass repoId+branch.",
        });
      }

      const scanResult = await runPrScan(pr.id);
      const isProductionReady = scanResult.rating >= 4;

      return NextResponse.json({
        status: "Success",
        type: "check",
        message: `Inspected Pull Request ${pr.id}: "${pr.title}" completed successfully.`,
        rating: `${scanResult.rating}/5`,
        productionGrade: isProductionReady ? "YES" : "NO",
        summary: isProductionReady
          ? "Production readiness: APPROVED (Score 4+)"
          : "Production readiness: REJECTED (Requires fixes. Below 4/5)",
        findingsCount: scanResult.findings.length,
        findings: scanResult.findings.map((f: any) =>
          `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`
        )
      });
    }

    if (cmdName === "/prlist" || cmdName === "prlist" || cmdName === "list") {
      if (!body.repoId) {
        return NextResponse.json({
          status: "Error",
          message: "Pass { repoId } in the request body to list PRs."
        }, { status: 400 });
      }

      const prs = await prisma.pullRequest.findMany({
        where: { repoId: body.repoId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, title: true, sourceBranch: true, rating: true, status: true, createdAt: true },
      });

      return NextResponse.json({
        status: "Success",
        type: "list",
        repoId: body.repoId,
        pullRequests: prs.map(p => ({
          number: p.id.replace(/^pr-?/, ""),
          id: p.id,
          title: p.title,
          branch: p.sourceBranch,
          rating: p.rating != null ? `${p.rating}/5` : "Not scanned",
          status: p.status,
          createdAt: p.createdAt,
        })),
      });
    }

    if (cmdName === "/prcomments" || cmdName === "prcomments" || cmdName === "comments") {
      const pr = await resolvePr(body, argVal);
      if (!pr) {
        return NextResponse.json({
          status: "Error",
          message: argVal
            ? `Pull Request for "${argVal}" not found.`
            : "No PR specified and no branch match. Provide a PR number, or pass repoId+branch.",
        });
      }

      const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
      return NextResponse.json({
        status: "Success",
        type: "comments",
        prId: pr.id,
        title: pr.title,
        productionScore: pr.rating ? `${pr.rating}/5` : "Not Scanned Yet",
        comments: findings.map(f =>
          `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`
        )
      });
    }

    return NextResponse.json({
      status: "Error",
      message:
        `Command "${cmdName}" is unknown. Supported:\n` +
        `- /prcheck [number]   (Reviews a PR — use number or send repoId+branch)\n` +
        `- /prcomments [number] (Gets review findings)`
    }, { status: 400 });
  } catch (err: any) {
    console.error("[MCP general action error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
