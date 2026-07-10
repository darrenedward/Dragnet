import { createSign } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const CACHE_TTL_MS = 50 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

function getAppCredentials(): { appId: string; privateKey: string } {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error(
      "GitHub App not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (base64-encoded PEM) in .env.local",
    );
  }
  return { appId, privateKey: Buffer.from(privateKey, "base64").toString("utf8") };
}

function signJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: appId,
    iat: now - 60,
    exp: now + 600,
  };

  const base64Url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64url")
      .replace(/=+$/, "");

  const headerB64 = base64Url(header);
  const payloadB64 = base64Url(payload);
  const message = `${headerB64}.${payloadB64}`;

  const sign = createSign("RSA-SHA256");
  sign.update(message);
  const signature = sign.sign(privateKey, "base64url");

  return `${message}.${signature}`;
}

export async function getInstallationToken(installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const { appId, privateKey } = getAppCredentials();
  const jwt = signJwt(appId, privateKey);

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API error fetching installation token: ${res.status} ${res.statusText} — ${body}`,
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at).getTime();

  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: expiresAt - CACHE_TTL_MS,
  });

  return data.token;
}

export function clearTokenCache(installationId: string): void {
  tokenCache.delete(installationId);
}

export function clearAllTokenCaches(): void {
  tokenCache.clear();
}

export function buildHttpsCloneUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

export function parseOwnerRepo(cloneUrl: string): { owner: string; repo: string } {
  const match = cloneUrl.match(/(?:git@|https?:\/\/)[^:/]+[:/]([^/]+)\/([^/.]+)(?:\.git)?/);
  if (!match) throw new Error(`Cannot parse owner/repo from URL: ${cloneUrl}`);
  return { owner: match[1], repo: match[2] };
}
