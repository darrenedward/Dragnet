import { NextResponse } from "next/server";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { getDashboardMetrics } from "@/src/services/dashboardMetrics";

export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    return NextResponse.json(await getDashboardMetrics(), {
      headers: { "Cache-Control": "max-age=0, must-revalidate" },
    });
  } catch (error) {
    console.error("[dashboard-metrics] failed to aggregate metrics:", error);
    return NextResponse.json({ error: "Unable to load dashboard metrics." }, { status: 500 });
  }
}
