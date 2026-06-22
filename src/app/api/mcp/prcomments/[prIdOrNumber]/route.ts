import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber } from "@/src/lib/findPr";
import { authenticateMcpRequest } from "@/src/lib/mcpAuth";

export async function GET(req: Request, { params }: { params: Promise<{ prIdOrNumber: string }> }) {
  const auth = await authenticateMcpRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ status: "Error", message: auth.error }, { status: 401 });
  }

  const { prIdOrNumber } = await params;
  try {
    const pr = await findPrByIdOrNumber(prIdOrNumber);
    if (!pr) {
      return NextResponse.json({
        status: "Error",
        message: `Pull request reference "${prIdOrNumber}" could not be matched in the database.`
      }, { status: 404 });
    }

    const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
    const ratingInfo = pr.rating ? `${pr.rating}/10` : "Unrated";
    const isProduction = pr.rating ? (pr.rating >= 9 ? "YES" : "NO") : "N/A";

    return NextResponse.json({
      status: "Success",
      prId: pr.id,
      title: pr.title,
      productionScore: ratingInfo,
      productionGrade: isProduction,
      comments: findings.map(f => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        filename: f.filename,
        line: f.line,
        comment: f.explanation,
        fixSuggestion: f.diffSuggestion,
        evidenceChain: f.evidenceChain ? JSON.parse(f.evidenceChain) : []
      }))
    });
  } catch (err: any) {
    console.error("[MCP prcomments error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
