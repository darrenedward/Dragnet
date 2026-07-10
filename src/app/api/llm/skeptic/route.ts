import { NextResponse } from "next/server";
import {
  DEFAULT_SKEPTIC,
  clearSkepticCache,
  readSkeptic,
  saveSkeptic,
} from "@/src/lib/skepticConfig";
import { validateSkeptic } from "@/src/lib/skepticValidation";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

/**
 * GET /api/llm/skeptic — returns the current SkepticSettings.
 *
 * Auth: session cookie OR Bearer API key. The issue is explicit about
 * supporting both, so this route uses `authenticateSessionOrKey` rather
 * than the cookie-only `requireSession` used by the review-limits route.
 */
export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401 });
  }
  try {
    return NextResponse.json({
      ok: true,
      skeptic: readSkeptic(),
      defaults: DEFAULT_SKEPTIC,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/llm/skeptic — body: `{enabled: boolean}`.
 * Validates, persists atomically (.tmp → rename → chmod 0600), then clears
 * the cache so the next scan picks up the new value.
 */
export async function PUT(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401 });
  }
  try {
    const incoming = await req.json().catch(() => ({}));
    const next = validateSkeptic(incoming);
    await saveSkeptic(next);
    clearSkepticCache();
    return NextResponse.json({
      ok: true,
      message: next.enabled
        ? "Skeptic pass enabled. Scans will use the fallback chat model to adjudicate findings."
        : "Skeptic pass disabled.",
      skeptic: next,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 400 },
    );
  }
}
