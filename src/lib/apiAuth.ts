import { prisma } from "./prisma";
import crypto from "crypto";
import { requireSession } from "./api-auth";

const KEY_PREFIX = "dr_";

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = KEY_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 8) + "...";
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, prefix, hash };
}

function hashKey(raw: string): string | null {
  if (!raw.startsWith(KEY_PREFIX)) return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function authenticateApiRequest(req: Request): Promise<{ ok: boolean; error?: string }> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return { ok: false, error: "Missing or invalid Authorization header. Use: Authorization: Bearer dr_<key>" };
  }

  const raw = auth.slice("Bearer ".length).trim();
  const hash = hashKey(raw);
  if (!hash) {
    return { ok: false, error: "Invalid API key format. Keys start with 'dr_'." };
  }

  const key = await prisma.apiKey.findUnique({ where: { hash } });
  if (!key || key.revoked) {
    return { ok: false, error: "API key not found or has been revoked." };
  }

  // Throttle lastUsedAt updates to once per 5 min per key — high-traffic
  // CLI usage was causing 1 write per request. Fire-and-forget so request
  // latency doesn't depend on the write.
  const lastMs = key.lastUsedAt ? new Date(key.lastUsedAt).getTime() : 0;
  if (Date.now() - lastMs > 5 * 60_000) {
    prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  return { ok: true };
}

/**
 * Auth helper for routes that should accept EITHER a browser session
 * (cookie-based, for the dashboard UI) OR a Bearer API key (for CLI /
 * programmatic access). Performs real DB-backed validation of whichever
 * credential is presented — no header heuristics.
 *
 * Replaces the old `authenticateIfExternal` which trusted the Host header
 * (attacker-controlled in HTTP/1.1) to decide whether to require auth.
 * `Host: localhost:3300` from any TCP client bypassed auth entirely.
 *
 * Order: API key first (single DB lookup), then session (Better Auth
 * verifies the cookie against the sessions table).
 */
export async function authenticateSessionOrKey(req: Request): Promise<{ ok: boolean; error?: string }> {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authenticateApiRequest(req);
  }
  try {
    await requireSession(req);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Authentication required. Send a Bearer API key (Authorization: Bearer dr_…) or a valid session cookie.",
    };
  }
}
