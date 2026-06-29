/**
 * Shared HTTP helper. Every browser-side fetch in the dashboard should go
 * through `fetchJson` so that an expired Better Auth session triggers a
 * single, consistent redirect to /login?callbackURL=<encoded current path>
 * instead of leaving the user staring at a stale UI or a 401 error toast.
 *
 * Why centralised: 48+ fetch sites across hooks/components. Per-site 401
 * handling would drift; this is the one-and-done chokepoint.
 *
 * Server-side fetches (Route Handlers, server components) MUST NOT use this
 * — `window` is undefined there. Use raw `fetch` and let the route enforce
 * auth via `authenticateSessionOrKey(req)`.
 */

const LOGIN_PATH = "/login";

/**
 * Error thrown when the underlying `fetch()` rejects — i.e. the server is
 * unreachable (down, DNS failure, CORS preflight rejected, offline).
 * Distinct from a 5xx response, which means the server IS reachable but
 * the request failed server-side.
 *
 * Friendly `message` so callers can render it directly without re-formatting.
 * Callers can also branch on `instanceof NetworkError` for custom handling.
 */
export class NetworkError extends Error {
  constructor(message = "Lost connection to the Dragnet server.") {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Redirect the browser to /login, preserving the current path+search as
 * `callbackURL` so the login page can send the user back where they were.
 *
 * Same-origin guard: if the redirect is invoked during SSR or from a
 * non-browser context, no-op (don't crash the render).
 *
 * Idempotent guard: if we're already on /login, don't recurse — otherwise
 * a 401 on the login page itself (e.g. a stale session check) would
 * redirect to /login?callbackURL=/login%3F... in an infinite loop.
 */
export function redirectToLogin(fromPath?: string): void {
  if (typeof window === "undefined") return;
  const current = fromPath ?? window.location.pathname + window.location.search;
  if (window.location.pathname === LOGIN_PATH) return;
  const url = `${LOGIN_PATH}?callbackURL=${encodeURIComponent(current)}`;
  window.location.assign(url);
}

/**
 * Fetch wrapper that mirrors the global `fetch` signature, then on a 401
 * response (session expired / cookie revoked) redirects to /login with the
 * current path preserved.
 *
 * Returns the original `Response` so callers can `.json()`, `.text()`, etc.
 * The redirect is fire-and-forget — after it triggers, callers' downstream
 * `.json()` parsing runs on a document that's about to be replaced, which
 * is fine (React will tear down before any state update lands).
 *
 * Only triggers on same-origin requests — a 401 from a third-party API
 * (e.g. an OpenRouter or GitHub call proxied through the client) is the
 * remote service's problem, not a session issue.
 *
 * Throws `NetworkError` (not raw `TypeError`) when the underlying fetch
 * rejects — that's the "server down / offline" path. Callers can render
 * the friendly `.message` directly or branch via `instanceof NetworkError`.
 */
export async function fetchJson(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    // Browsers raise a TypeError "Failed to fetch" for: server down, DNS
    // failure, CORS preflight rejection, navigator offline. Re-throw as
    // NetworkError so callers don't have to string-match the message.
    if (err instanceof TypeError && /fetch/i.test(err.message)) {
      throw new NetworkError();
    }
    throw err;
  }
  if (response.status === 401 && isSameOrigin(input)) {
    redirectToLogin();
  }
  return response;
}

function isSameOrigin(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;
  if (input instanceof Request) {
    return new URL(input.url, window.location.origin).origin === window.location.origin;
  }
  if (input instanceof URL) {
    return input.origin === window.location.origin;
  }
  // String input — may be relative ("/api/foo") or absolute ("https://...")
  try {
    return new URL(input, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}
