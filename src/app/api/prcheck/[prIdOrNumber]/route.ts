import { NextResponse } from "next/server";
import { findPrByIdOrNumber } from "@/src/lib/findPr";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { admitScanJobForPr } from "@/src/services/scanQueue";

/** CLI/API prcheck admission. Execution belongs exclusively to the durable worker. */
export async function GET(req: Request, { params }: { params: Promise<{ prIdOrNumber: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ status: "Error", message: auth.error }, { status: 401 });
  }

  const { prIdOrNumber } = await params;
  const url = new URL(req.url);
  const pr = await findPrByIdOrNumber(prIdOrNumber, url.searchParams.get("repoId") || undefined);
  if (!pr) {
    return NextResponse.json({
      status: "Error",
      message: `Pull request reference "${prIdOrNumber}" could not be matched in the database.`,
    }, { status: 404 });
  }

  const job = await admitScanJobForPr({
    prId: pr.id,
    triggerReason: "prcheck",
    forced: url.searchParams.get("force") === "true",
    createdByUserId: auth.userId,
  });
  if (!job) {
    return NextResponse.json({ status: "Error", message: "Pull request disappeared before scan admission." }, { status: 404 });
  }

  return NextResponse.json({
    status: "Accepted",
    prId: pr.id,
    title: pr.title,
    jobId: job.jobId,
    state: job.state,
    queuePosition: job.queuePosition,
  }, { status: 202 });
}
