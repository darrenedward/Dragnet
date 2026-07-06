import crypto from "node:crypto";

function stripAuth(path: string): string {
  return path.includes("@") ? path.slice(path.lastIndexOf("@") + 1) : path;
}

function stripPort(host: string): string {
  return host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
}

function stripTrailingGit(path: string): string {
  return path.replace(/\.git$/, "");
}

function stripLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function canonicalizeUrl(remoteUrl: string): string {
  if (!remoteUrl) throw new Error(`Cannot parse git remote URL: ${remoteUrl}`);

  const sshMatch = remoteUrl.match(/^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):(.+)$/);
  if (sshMatch) {
    let host = sshMatch[2].toLowerCase();
    host = stripPort(host);
    let path = stripTrailingGit(sshMatch[3]).toLowerCase();
    path = stripLeadingSlash(path);
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  const httpsMatch = remoteUrl.match(/^https:\/\/(.+)$/);
  if (httpsMatch) {
    const rest = httpsMatch[1];
    const atIdx = rest.lastIndexOf("@");
    const afterUserinfo = atIdx >= 0 ? rest.slice(atIdx + 1) : rest;
    const slashIdx = afterUserinfo.indexOf("/");
    let host = slashIdx >= 0 ? afterUserinfo.slice(0, slashIdx) : afterUserinfo;
    let path = slashIdx >= 0 ? afterUserinfo.slice(slashIdx + 1) : "";
    host = stripPort(host).toLowerCase();
    path = stripTrailingGit(path).toLowerCase();
    path = stripLeadingSlash(path);
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  const gitMatch = remoteUrl.match(/^git:\/\/(.+)$/);
  if (gitMatch) {
    const rest = gitMatch[1];
    const slashIdx = rest.indexOf("/");
    let host = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    let path = slashIdx >= 0 ? rest.slice(slashIdx + 1) : "";
    host = stripPort(host).toLowerCase();
    path = stripTrailingGit(path).toLowerCase();
    path = stripLeadingSlash(path);
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  // ssh:// protocol: ssh://git@host:port/path or ssh://host/path
  const sshProtocolMatch = remoteUrl.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::\d+)?\/(.+)$/);
  if (sshProtocolMatch) {
    let host = sshProtocolMatch[2].toLowerCase();
    let path = stripTrailingGit(sshProtocolMatch[3]).toLowerCase();
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  throw new Error(`Cannot parse git remote URL: ${remoteUrl}`);
}

export function computeRepoId(remoteUrl: string): string {
  const canonical = canonicalizeUrl(remoteUrl);
  return canonical.replace(/^https:\/\//, "");
}

export function computeLocalRepoId(localPath: string): string {
  const hash = crypto.createHash("sha256").update(localPath).digest("hex");
  return `local/${hash.slice(0, 16)}`;
}

export function parseOwnerRepoFromUrl(canonicalUrl: string): { owner: string; repo: string } {
  const match = canonicalUrl.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`Cannot parse owner/repo from canonical URL: ${canonicalUrl}`);
  return { owner: match[1], repo: match[2] };
}
