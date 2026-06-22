import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber } from "@/src/lib/findPr";
import { runPrScan } from "@/reviewService";
import { authenticateMcpRequest } from "@/src/lib/mcpAuth";

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
      message: "Command field is required. Example format: '/prcheck 2' or '/prcomments 2'."
    }, { status: 400 });
  }

  const cleanCommand = command.trim();
  const parts = cleanCommand.split(/\s+/);
  const cmdName = parts[0];
  const argVal = parts.slice(1).join(" ");

  try {
    if (cmdName === "/prcheck" || cmdName === "/checkpr" || cmdName === "checkpr" || cmdName === "prcheck") {
      if (!argVal) {
        return NextResponse.json({
          status: "Error",
          message: "Please specify a PR ID or matching index number. Example: '/prcheck 2'."
        }, { status: 400 });
      }

      const pr = await findPrByIdOrNumber(argVal);
      if (!pr) {
        return NextResponse.json({
          status: "Error",
          message: `Pull Request context for descriptor "${argVal}" was not found.`
        });
      }

      const scanResult = await runPrScan(pr.id);
      const isProductionReady = scanResult.rating >= 9;

      return NextResponse.json({
        status: "Success",
        type: "check",
        message: `Inspected Pull Request ${pr.id}: "${pr.title}" completed successfully.`,
        rating: `${scanResult.rating}/10`,
        productionGrade: isProductionReady ? "YES" : "NO",
        summary: isProductionReady
          ? "Production readiness: APPROVED (Score 9+)"
          : "Production readiness: REJECTED (Requires fixes. Below 9/10)",
        findingsCount: scanResult.findings.length,
        findings: scanResult.findings.map((f: any) =>
          `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`
        )
      });
    }

    if (cmdName === "/prcomments" || cmdName === "prcomments" || cmdName === "comments") {
      if (!argVal) {
        return NextResponse.json({
          status: "Error",
          message: "Please specify a PR ID or matching index number. Example: '/prcomments 2'."
        }, { status: 400 });
      }

      const pr = await findPrByIdOrNumber(argVal);
      if (!pr) {
        return NextResponse.json({
          status: "Error",
          message: `Pull Request context for descriptor "${argVal}" was not found.`
        });
      }

      const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
      return NextResponse.json({
        status: "Success",
        type: "comments",
        prId: pr.id,
        title: pr.title,
        productionScore: pr.rating ? `${pr.rating}/10` : "Not Scanned Yet",
        comments: findings.map(f =>
          `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`
        )
      });
    }

    return NextResponse.json({
      status: "Error",
      message:
        `Command "${cmdName}" is unknown. Supported commands:\n` +
        `- /prcheck <index> (Inspects the PR and rates 1-10)\n` +
        `- /prcomments <index> (Retrieves review findings left in database)`
    }, { status: 400 });
  } catch (err: any) {
    console.error("[MCP general action error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
