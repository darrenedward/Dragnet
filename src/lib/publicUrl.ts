/**
 * Resolves Dragnet's externally-reachable URL and whether it's a
 * localhost-only address. Drives the WebhookPrompt branch: when
 * `isLocal === true`, the prompt shows Cloudflare Tunnel setup steps
 * first (GitHub/GitLab can't deliver webhooks to localhost); when
 * false, it skips straight to webhook creation.
 *
 * The URL is sourced from `DRAGNET_PUBLIC_URL` (set this to a tunnel
 * URL or a VPS public URL). Defaults to `http://localhost:3300`
 * (matches the dev server port in package.json).
 */
const LOCALHOST_PATTERN = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/;

export function getPublicUrl(): { url: string; isLocal: boolean } {
  const url = process.env.DRAGNET_PUBLIC_URL || "http://localhost:3300";
  const isLocal = LOCALHOST_PATTERN.test(url);
  return { url, isLocal };
}
