/**
 * Resolves Dragnet's externally-reachable URL and whether it's a
 * localhost-only address. Drives the WebhookPrompt branch: when
 * `isLocal === true`, the prompt shows Cloudflare Tunnel setup steps
 * first (GitHub/GitLab can't deliver webhooks to localhost); when
 * false, it skips straight to webhook creation.
 *
 * The URL is sourced from the server-owned `.dragnet/public-url.json` file
 * when configured in the UI. Environment variables remain useful as
 * deployment overrides, with DRAGNET_URL as the local-server fallback.
 */
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOCALHOST_PATTERN = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/;
const DEFAULT_PUBLIC_URL = "http://localhost:3300";

function publicUrlPath(): string {
  return join(/* turbopackIgnore: true */ process.cwd(), ".dragnet", "public-url.json");
}

function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const url = value.trim().replace(/\/$/, "");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function readSavedPublicUrl(): string | null {
  if (!existsSync(publicUrlPath())) return null;
  try {
    const parsed = JSON.parse(readFileSync(publicUrlPath(), "utf8")) as { url?: unknown };
    return normalizePublicUrl(parsed.url);
  } catch {
    return null;
  }
}

export function getPublicUrl(): { url: string; isLocal: boolean } {
  const url =
    readSavedPublicUrl() ||
    normalizePublicUrl(process.env.DRAGNET_PUBLIC_URL) ||
    normalizePublicUrl(process.env.DRAGNET_URL) ||
    DEFAULT_PUBLIC_URL;
  const isLocal = LOCALHOST_PATTERN.test(url);
  return { url, isLocal };
}

export function publicUrlIsConfigured(): boolean {
  return Boolean(
    readSavedPublicUrl() ||
      normalizePublicUrl(process.env.DRAGNET_PUBLIC_URL),
  );
}

export function validatePublicUrl(value: unknown): string {
  const normalized = normalizePublicUrl(value);
  if (!normalized) throw new Error("Public URL must be a valid http:// or https:// URL.");
  return normalized;
}

export async function savePublicUrl(value: unknown): Promise<string> {
  const url = validatePublicUrl(value);
  const dir = join(/* turbopackIgnore: true */ process.cwd(), ".dragnet");
  const target = publicUrlPath();
  const tmp = `${target}.tmp`;
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify({ url }, null, 2), { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o600);
  return url;
}

export function publicUrlPathname(): string {
  return publicUrlPath();
}
