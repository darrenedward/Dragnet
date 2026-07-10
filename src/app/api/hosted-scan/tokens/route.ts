import { NextResponse } from "next/server";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { createScanToken, listScanTokens } from "@/src/services/hostedScan/scanToken";

export async function GET(request: Request) {
  const auth = await authenticateSessionOrKey(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const url = new URL(request.url);
  const repoId = url.searchParams.get("repoId");
  if (!repoId) {
    return NextResponse.json({ error: "repoId query parameter is required" }, { status: 400 });
  }

  const tokens = await listScanTokens(repoId);
  return NextResponse.json({ tokens });
}

export async function POST(request: Request) {
  const auth = await authenticateSessionOrKey(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.repoId || !body.label) {
    return NextResponse.json({ error: "repoId and label are required" }, { status: 400 });
  }

  const result = await createScanToken(body.repoId, body.label);
  if (!result.ok) {
    return NextResponse.json({ error: (result as { error: string }).error }, { status: 400 });
  }

  return NextResponse.json({ token: result.token }, { status: 201 });
}
