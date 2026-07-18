import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Next.js 16 network-boundary gate (the renamed `middleware` convention —
 * Vercel PR #84119). Requires a Better Auth session for the JSON API.
 *
 * WARNING: this is a lightweight cookie-PRESENCE check only —
 * `getSessionCookie` does NOT verify the cookie signature at the network
 * boundary (Prisma is Node-only and can't run here). Any request with a
 * cookie header shaped like `better-auth.session=...` passes. This is
 * a coarse DOS / drive-by filter, NOT real authentication.
 *
 * Real authentication is enforced at each route handler via
 * `authenticateSessionOrKey(req)` — which performs DB-backed validation
 * of either a session cookie (Better Auth verifies against the sessions
 * table) or a Bearer API key (SHA-256 hash lookup in api_keys). Routes
 * that forget this call are effectively unauthenticated.
 *
 * The matcher deliberately excludes endpoints that authenticate by other
 * means, so they must NOT be gated by a browser session cookie:
 *   - /api/auth/*       Better Auth's own handler (login/register/session)
 *   - /api/webhooks/*   HMAC-verified (verifyGithubSignature)
 *   - /api/hooks/*      API key (Authorization: Bearer dr_…) from the CLI/hook
 *   - /api/command, /api/prcheck, /api/prcomments  API-key endpoints (skill/CLI)
 *
 * Note: /api/keys is intentionally NOT excluded — key minting/listing
 * must require a logged-in session (it's a browser-only, UI-driven route).
 */
export async function proxy(req: NextRequest) {
  const session = getSessionCookie(req);
  const authHeader = req.headers.get("authorization");
  const hasBearerKey = authHeader && authHeader.startsWith("Bearer dr_");
  const queueWorkerToken = process.env.DRAGNET_MASTER_KEY;
  const isQueueWorker = Boolean(
    queueWorkerToken && req.headers.get("x-dragnet-queue-worker") === queueWorkerToken,
  );

  if (!session && !hasBearerKey && !isQueueWorker) {
    return NextResponse.json(
      {
        error:
          "Unauthorized. Sign in to Dragnet, or call API-key endpoints " +
          "(/api/command, /api/prcheck, /api/prcomments, /api/hooks/*) with Authorization: Bearer dr_<key>.",
      },
      { status: 401 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/((?!auth|webhooks|hooks|command|prcheck|prcomments).*)",
  ],
};
