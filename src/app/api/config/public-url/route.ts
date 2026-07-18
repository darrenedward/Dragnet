import { NextResponse } from "next/server";
import { getPublicUrl, publicUrlIsConfigured, savePublicUrl } from "@/src/lib/publicUrl";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function GET(req: Request) {
  // Route-level auth: exposes configured public URL (deployment metadata).
  // proxy.ts is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    return NextResponse.json({ ...getPublicUrl(), configured: publicUrlIsConfigured() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const url = await savePublicUrl(body.url);
    return NextResponse.json({ ok: true, ...getPublicUrl(), configured: true, url });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 400 });
  }
}
