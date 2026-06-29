import { NextResponse } from "next/server";
import {
  DEFAULT_LIMITS,
  clearLimitsCache,
  readLimits,
  saveLimits,
} from "@/src/lib/prSizeConfig";
import { validateLimits } from "@/src/lib/reviewLimitsValidation";
import { requireSession } from "@/src/lib/api-auth";

/**
 * GET /api/llm/review-limits — returns the current ReviewLimits.
 * Safe for client use (no secrets in the payload).
 */
export async function GET(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, limits: readLimits(), defaults: DEFAULT_LIMITS });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/llm/review-limits — body: full ReviewLimits object.
 * Validates bounds, persists atomically (.tmp → rename → chmod 0600),
 * then clears the cache so the next scan picks up new values.
 */
export async function PUT(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const incoming = await req.json().catch(() => ({}));
    const next = validateLimits(incoming);
    await saveLimits(next);
    clearLimitsCache();
    return NextResponse.json({
      ok: true,
      message: "Review limits saved.",
      limits: next,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 400 },
    );
  }
}
