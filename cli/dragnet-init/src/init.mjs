import { execSync } from "child_process";

export function canonicalizeUrl(remoteUrl) {
  const sshMatch = remoteUrl.match(/^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[2];
    const path = sshMatch[3].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  const httpsMatch = remoteUrl.match(/^https:\/\/([a-zA-Z0-9.-]+)\/(.+)$/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const path = httpsMatch[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  const gitMatch = remoteUrl.match(/^git:\/\/([a-zA-Z0-9.-]+)\/(.+)$/);
  if (gitMatch) {
    const host = gitMatch[1];
    const path = gitMatch[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  // ssh:// protocol: ssh://git@host:port/path or ssh://host/path
  const sshProtocolMatch = remoteUrl.match(/^ssh:\/\/(?:[^@]+@)?([^:/]+)(?::\d+)?\/(.+)$/);
  if (sshProtocolMatch) {
    const host = sshProtocolMatch[1];
    const path = sshProtocolMatch[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  throw new Error(`Cannot parse git remote URL: ${remoteUrl}`);
}

/**
 * Resolve a project's API key + URL by hitting the Dragnet lookup endpoint.
 * Returns `{ repoId, apiKey, apiBase }` for the caller to print as env vars.
 *
 * Previously this wrote `.dragnet/repo.json` + updated `.gitignore`. Per the
 * Per-Project API Keys PRD (#33), the agent skill and pre-push hook now read
 * `$DRAGNET_REPO_KEY` + `$DRAGNET_URL` directly from the environment — no
 * filesystem config. This CLI just resolves the values; the bin script prints
 * the `export ...` lines for the user to paste into their shell.
 */
export async function runInit({
  cwd = process.cwd(),
  apiBase = process.env.DRAGNET_URL || "http://localhost:3300",
  prompt,
  local = false,
  execSync: exec = execSync,
  fetch: fetchFn = globalThis.fetch,
} = {}) {
  if (local) {
    const repoId = await prompt("Paste the repository ID from the Dragnet dashboard: ");
    return {
      repoId,
      apiKey: null,
      apiBase,
    };
  }

  let remoteUrl;
  try {
    remoteUrl = exec("git remote get-url origin", { encoding: "utf8", cwd }).trim();
  } catch {
    throw new Error("No git remote 'origin' found. Register the repo in the Dragnet dashboard first, or use --local to paste a repoId manually.");
  }

  const canonical = canonicalizeUrl(remoteUrl);
  const lookupUrl = `${apiBase}/api/repos/lookup?remoteUrl=${encodeURIComponent(canonical)}`;
  const res = await fetchFn(lookupUrl);
  const data = await res.json();

  if (!data.exists) {
    throw new Error(`Repository not found at ${apiBase}. Register it first in the Dragnet dashboard, or use --local for a local-only repo.`);
  }

  return {
    repoId: data.repoId,
    apiKey: data.apiKey,
    apiBase: data.apiBase || apiBase,
  };
}
