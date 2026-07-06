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

export type AuthResult = {
  ok: boolean;
  error?: string;
  repoId: string | null;
  /** User that owns the credential used to authenticate. Null for legacy keys (no userId column at creation). */
  userId: string | null;
};

export async function authenticateApiRequest(req: Request): Promise<AuthResult> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return { ok: false, error: "Missing or invalid Authorization header. Use: Authorization: Bearer dr_<key>", repoId: null, userId: null };
  }

  const raw = auth.slice("Bearer ".length).trim();
  const hash = hashKey(raw);
  if (!hash) {
    return { ok: false, error: "Invalid API key format. Keys start with 'dr_'.", repoId: null, userId: null };
  }

  const key = await prisma.apiKey.findUnique({ where: { hash } });
  if (!key || key.revoked) {
    return { ok: false, error: "API key not found or has been revoked.", repoId: null, userId: null };
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

  return { ok: true, repoId: key.repoId ?? null, userId: key.userId ?? null };
}

/**
 * Checks that the authenticated key's repo scope allows access to the target
 * repo. Global keys (repoId === null) can access any repo. Repo-scoped keys
 * can only access their own repo. Returns null on success, or a 403 response
 * body on mismatch.
 */
export function enforceRepoScope(
  auth: AuthResult,
  targetRepoId: string,
): { error: string } | null {
  if (!auth.ok) {
    return { error: auth.error || "Authentication required." };
  }
  if (auth.repoId !== null && auth.repoId !== targetRepoId) {
    return { error: "API key does not have access to this repository." };
  }
  return null;
}

/**
 * Checks that the authenticated key's repo scope allows access to the
 * repo that owns the given PR. Looks up the PR in the DB, resolves its
 * repoId, then delegates to enforceRepoScope. Returns null on success,
 * or a 403/404 response body on mismatch or missing PR.
 */
export async function enforcePrRepoScope(
  auth: AuthResult,
  prId: string,
): Promise<{ error: string } | null> {
  if (!auth.ok) return { error: auth.error || "Authentication required." };
  if (auth.repoId === null) return null; // global key — any repo
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId },
    select: { repoId: true },
  });
  if (!pr) return { error: "PR not found." };
  if (auth.repoId !== pr.repoId) {
    return { error: "API key does not have access to this repository." };
  }
  return null;
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
export async function authenticateSessionOrKey(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authenticateApiRequest(req);
  }
  try {
    const session = await requireSession(req);
    const userId = session?.user?.id ?? null;
    return { ok: true, repoId: null, userId };
  } catch {
    return {
      ok: false,
      error: "Authentication required. Send a Bearer API key (Authorization: Bearer dr_…) or a valid session cookie.",
      repoId: null,
      userId: null,
    };
  }
}
