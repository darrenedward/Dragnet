import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforcePrRepoScope } from "@/src/lib/apiAuth";

export async function GET(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  // Route-level auth: PR files expose diff content (source code). proxy.ts
  // is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { prId } = await params;
    const prScopeErr = await enforcePrRepoScope(auth, prId);
    if (prScopeErr) return NextResponse.json(prScopeErr, { status: 403 });
    const files = await prisma.prFile.findMany({ where: { prId } });
    return NextResponse.json(files);
  } catch (err: any) {
    console.error("Error fetching files for PR:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
