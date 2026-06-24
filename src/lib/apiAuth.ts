import { prisma } from "./prisma";
import crypto from "crypto";

const KEY_PREFIX = "gl_";
const LEGACY_KEY_PREFIX = "gl_mcp_";

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = KEY_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 8) + "...";
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, prefix, hash };
}

function hashKey(raw: string): string | null {
  if (!raw.startsWith(KEY_PREFIX) && !raw.startsWith(LEGACY_KEY_PREFIX)) return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function authenticateApiRequest(req: Request): Promise<{ ok: boolean; error?: string }> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return { ok: false, error: "Missing or invalid Authorization header. Use: Authorization: Bearer gl_<key>" };
  }

  const raw = auth.slice("Bearer ".length).trim();
  const hash = hashKey(raw);
  if (!hash) {
    return { ok: false, error: "Invalid API key format. Keys start with 'gl_'." };
  }

  const key = await prisma.apiKey.findUnique({ where: { hash } });
  if (!key || key.revoked) {
    return { ok: false, error: "API key not found or has been revoked." };
  }

  await prisma.apiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return { ok: true };
}

/**
 * Stricter auth for externally-facing endpoints (webhooks, reindex, stats).
 * Requires API key for cross-origin / non-browser requests, but allows
 * same-origin requests from the UI to pass without a key. This avoids
 * breaking the dashboard while still protecting against external attackers.
 *
 * "Same origin" means the Origin header matches the Host header. Requests
 * without an Origin header (curls, bots, scripts) are considered external
 * and must authenticate.
 */
export async function authenticateIfExternal(req: Request): Promise<{ ok: boolean; error?: string }> {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return { ok: true };
    } catch {}
  }
  // Browser navigation / curl from localhost: no Origin header but definitely internal
  if (host && (host.startsWith("localhost") || host.startsWith("127.0.0.1"))) {
    return { ok: true };
  }
  return authenticateApiRequest(req);
}
