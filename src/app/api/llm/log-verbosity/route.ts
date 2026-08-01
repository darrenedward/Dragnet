import { NextResponse } from "next/server";
import {
  DEFAULT_LOG_VERBOSITY_SETTINGS,
  clearLogVerbosityCache,
  readLogVerbosity,
  saveLogVerbosity,
  LOG_VERBOSITY_LEVELS,
} from "@/src/lib/logVerbosity";
import { validateLogVerbosity } from "@/src/lib/logVerbosityValidation";
import { requireSession } from "@/src/lib/api-auth";

/**
 * GET /api/llm/log-verbosity — current operator log verbosity setting.
 */
export async function GET(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({
      ok: true,
      settings: readLogVerbosity(),
      defaults: DEFAULT_LOG_VERBOSITY_SETTINGS,
      levels: LOG_VERBOSITY_LEVELS,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * PUT /api/llm/log-verbosity — body: `{ level: "user"|"warn"|"error"|"debug" }`.
 * Persists atomically and clears cache so the next log line uses the new min.
 */
export async function PUT(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const incoming = await req.json().catch(() => ({}));
    const next = validateLogVerbosity(incoming);
    await saveLogVerbosity(next);
    clearLogVerbosityCache();
    return NextResponse.json({
      ok: true,
      message: `Log verbosity set to ${labelFor(next.level)}.`,
      settings: next,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

function labelFor(level: string): string {
  switch (level) {
    case "user":
      return "User";
    case "warn":
      return "Warn";
    case "error":
      return "Error";
    case "debug":
      return "Debug";
    default:
      return level;
  }
}
