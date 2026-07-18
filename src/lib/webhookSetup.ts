import crypto from "node:crypto";
import { prisma } from "./prisma";
import { decryptSecret, hasMasterKey } from "./crypto";
import { getPublicUrl } from "./publicUrl";

const providerPatterns: [RegExp, string][] = [
  [/github\.com/i, "github"],
  [/gitlab\.(com|org)/i, "gitlab"],
];

export function getProviderFromUrl(cloneUrl: string, cloneUrlHttps?: string): string {
  const url = cloneUrlHttps || cloneUrl;
  for (const [re, label] of providerPatterns) {
    if (re.test(url)) return label;
  }
  return "github";
}

function parseOwnerRepo(url: string): { owner: string; repo: string } {
  const match = url.match(/(?:git@|https?:\/\/)[^:/]+[:/]([^/]+)\/([^/.]+)(?:\.git)?/);
  if (!match) throw new Error(`Cannot parse owner/repo from URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

function getApiBase(provider: string): string {
  if (provider === "gitlab") return "https://gitlab.com/api/v4";
  return "https://api.github.com";
}

export async function setupWebhookWithPat(
  repoId: string,
  opts?: { targetUrl?: string },
): Promise<{ webhookId: string }> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new Error(`Repository not found: ${repoId}`);
  if (!repo.patCipher || !repo.patIv || !repo.patTag) {
    throw new Error(`Repository ${repoId} has no PAT stored`);
  }
  if (!hasMasterKey()) throw new Error("DRAGNET_MASTER_KEY is not set");

  const pat = decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
  const provider = repo.provider || getProviderFromUrl(repo.cloneUrl || "", repo.cloneUrlHttps || undefined);
  const targetUrl = opts?.targetUrl || `${getPublicUrl().url}/api/webhooks/${provider}`;
  const secret = repo.webhookSecret || crypto.randomUUID();
  const apiUrl = getApiBase(provider);
  const { owner, repo: repoName } = parseOwnerRepo(repo.cloneUrlHttps || repo.cloneUrl || "");

  if (provider === "gitlab") {
    const encoded = encodeURIComponent(`${owner}/${repoName}`);
    const res = await fetch(`${apiUrl}/projects/${encoded}/hooks`, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": pat,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: targetUrl,
        push_events: true,
      pull_requests_events: true,
        token: secret,
        enable_ssl_verification: true,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitLab webhook creation failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    const webhookId = String(data.id);

    await prisma.repository.update({
      where: { id: repoId },
      data: { webhookId, webhookSecret: secret },
    });

    return { webhookId };
  }

  // GitHub
  const res = await fetch(`${apiUrl}/repos/${owner}/${repoName}/hooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push", "pull_request"],
      config: {
        url: targetUrl,
        content_type: "json",
        secret,
        insecure_ssl: "0",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub webhook creation failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const webhookId = String(data.id);

  await prisma.repository.update({
    where: { id: repoId },
    data: { webhookId, webhookSecret: secret },
  });

  return { webhookId };
}

export async function deleteWebhook(repoId: string): Promise<void> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo || !repo.webhookId) return;
  if (!repo.patCipher || !repo.patIv || !repo.patTag) {
    await prisma.repository.update({
      where: { id: repoId },
      data: { webhookId: null },
    });
    return;
  }
  if (!hasMasterKey()) throw new Error("DRAGNET_MASTER_KEY is not set");

  const pat = decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
  const provider = repo.provider || getProviderFromUrl(repo.cloneUrl || "", repo.cloneUrlHttps || undefined);
  const apiUrl = getApiBase(provider);
  const { owner, repo: repoName } = parseOwnerRepo(repo.cloneUrlHttps || repo.cloneUrl || "");

  if (provider === "gitlab") {
    const encoded = encodeURIComponent(`${owner}/${repoName}`);
    const res = await fetch(`${apiUrl}/projects/${encoded}/hooks/${repo.webhookId}`, {
      method: "DELETE",
      headers: { "PRIVATE-TOKEN": pat },
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitLab webhook deletion failed (${res.status}): ${text}`);
    }
  } else {
    const res = await fetch(`${apiUrl}/repos/${owner}/${repoName}/hooks/${repo.webhookId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub webhook deletion failed (${res.status}): ${text}`);
    }
  }

  await prisma.repository.update({
    where: { id: repoId },
    data: { webhookId: null },
  });
}

export function getManualWebhookInstructions(repo: {
  cloneUrl?: string | null;
  cloneUrlHttps?: string | null;
  webhookSecret?: string | null;
  provider?: string | null;
}): string {
  const provider = repo.provider || getProviderFromUrl(repo.cloneUrl || "", repo.cloneUrlHttps || undefined);
  const publicUrl = getPublicUrl().url;
  const webhookUrl = `${publicUrl}/api/webhooks/${provider}`;
  const secret = repo.webhookSecret || "(generated automatically)";

  if (provider === "gitlab") {
    return `## Manual GitLab Webhook Setup

1. Go to your project on GitLab → **Settings → Webhooks**
2. Enter the following:

   | Field | Value |
   |-------|-------|
   | URL | \`${webhookUrl}\` |
   | Secret Token | \`${secret}\` |
   | Trigger | ☑ Push events |

3. Click **Add webhook**
4. Copy the webhook ID from the URL
5. Run: \`curl -X POST ${publicUrl}/api/repos/<REPO_ID>/webhook -H 'Content-Type: application/json' -d '{"webhookId":"<ID>"}'\`
`;
  }

  return `## Manual GitHub Webhook Setup

1. Go to your repository on GitHub → **Settings → Webhooks → Add webhook**
2. Enter the following:

   | Field | Value |
   |-------|-------|
   | Payload URL | \`${webhookUrl}\` |
   | Content type | \`application/json\` |
   | Secret | \`${secret}\` |
   | Events | ☑ Just the push event |

3. Click **Add webhook**
4. Copy the webhook ID from the URL
5. Run: \`curl -X POST ${publicUrl}/api/repos/<REPO_ID>/webhook -H 'Content-Type: application/json' -d '{"webhookId":"<ID>"}'\`
`;
}
