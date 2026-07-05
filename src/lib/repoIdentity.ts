export function canonicalizeUrl(remoteUrl: string): string {
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

  throw new Error(`Cannot parse git remote URL: ${remoteUrl}`);
}

export function parseOwnerRepoFromUrl(canonicalUrl: string): { owner: string; repo: string } {
  const match = canonicalUrl.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`Cannot parse owner/repo from canonical URL: ${canonicalUrl}`);
  return { owner: match[1], repo: match[2] };
}
