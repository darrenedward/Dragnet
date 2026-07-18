import { NextResponse } from "next/server";
import {
  clearAutoRescanSettingsCache,
  readAutoRescanSettings,
  saveAutoRescanSettings,
} from "@/src/lib/autoRescanPolicy";
import { requireSession } from "@/src/lib/api-auth";

export async function GET(req: Request) {
  try {
    await requireSession(req);
    return NextResponse.json({ ok: true, settings: readAutoRescanSettings() });
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
}

export async function PUT(req: Request) {
  try {
    await requireSession(req);
    const body = await req.json().catch(() => ({}));
    if (typeof body.defaultEnabled !== "boolean") {
      return NextResponse.json({ ok: false, error: "defaultEnabled must be a boolean." }, { status: 400 });
    }
    await saveAutoRescanSettings({ defaultEnabled: body.defaultEnabled });
    clearAutoRescanSettingsCache();
    return NextResponse.json({ ok: true, settings: readAutoRescanSettings() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 400 });
  }
}
