import { NextResponse } from "next/server";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import {
  cancelScanJobById,
  listScanJobs,
  prioritizeScanJob,
  retryFailedScanJob,
} from "@/src/services/scanQueue";

export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    return NextResponse.json({ jobs: await listScanJobs() });
  } catch (error) {
    console.error("[scan-queue] list failed:", error);
    return NextResponse.json({ error: "Failed to load scan queue." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  if (!jobId || !["cancel", "retry", "prioritize"].includes(action)) {
    return NextResponse.json({ error: "jobId and a valid action are required." }, { status: 400 });
  }

  try {
    if (action === "cancel") {
      const changed = await cancelScanJobById(jobId);
      return changed
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: "Job is no longer cancellable." }, { status: 409 });
    }
    if (action === "prioritize") {
      const changed = await prioritizeScanJob(jobId);
      return changed
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: "Only queued jobs can be prioritized." }, { status: 409 });
    }
    const job = await retryFailedScanJob(jobId);
    return job
      ? NextResponse.json({ ok: true, job })
      : NextResponse.json({ error: "Only failed jobs can be retried." }, { status: 409 });
  } catch (error) {
    console.error(`[scan-queue] ${action} failed:`, error);
    return NextResponse.json({ error: "Queue operation failed." }, { status: 500 });
  }
}
