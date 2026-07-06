import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";

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

export function shouldAddGitignore(content, line) {
  return !content.split("\n").some(l => l.trim() === line.trim());
}

export async function runInit({
  cwd = process.cwd(),
  apiBase = process.env.DRAGNET_URL || "http://localhost:3300",
  prompt,
  local = false,
  execSync: exec = execSync,
  writeFile: write = writeFileSync,
  readFile: read = readFileSync,
  exists: exists = existsSync,
  appendFile: append = appendFileSync,
  mkdir: mkdir = mkdirSync,
  fetch: fetchFn = globalThis.fetch,
} = {}) {
  let repoId, apiKey, configApiBase;

  if (local) {
    repoId = await prompt("Paste the repository ID from the Dragnet dashboard: ");
    apiKey = "";
    configApiBase = apiBase;
  } else {
    let remoteUrl;
    try {
      remoteUrl = exec("git remote get-url origin", { encoding: "utf8", cwd }).trim();
    } catch {
      throw new Error("No git remote 'origin' found. Use --local for pure-local repos.");
    }

    const canonical = canonicalizeUrl(remoteUrl);
    const lookupUrl = `${apiBase}/api/repos/lookup?remoteUrl=${encodeURIComponent(canonical)}`;
    const res = await fetchFn(lookupUrl);
    const data = await res.json();

    if (!data.exists) {
      throw new Error(`Repository not found at ${apiBase}. Register it first in the Dragnet dashboard, or use --local for a local-only repo.`);
    }

    repoId = data.repoId;
    apiKey = data.apiKey;
    configApiBase = data.apiBase || apiBase;
  }

  const dragnetDir = `${cwd}/.dragnet`;
  mkdir(dragnetDir, { recursive: true, mode: 0o700 });

  const config = { repoId, apiKey, apiBase: configApiBase };
  write(`${dragnetDir}/repo.json`, JSON.stringify(config, null, 2), { mode: 0o600 });

  const gitignoreLine = ".dragnet/repo.json";
  const gitignorePath = `${cwd}/.gitignore`;

  if (exists(gitignorePath)) {
    const content = read(gitignorePath, "utf8");
    if (shouldAddGitignore(content, gitignoreLine)) {
      const answer = await prompt(`Add "${gitignoreLine}" to .gitignore? [Y/n] `);
      if (answer.toLowerCase() !== "n") {
        append(gitignorePath, `\n# Dragnet local state\n${gitignoreLine}\n`);
      }
    }
  } else {
    const answer = await prompt(`Create .gitignore with "${gitignoreLine}"? [Y/n] `);
    if (answer.toLowerCase() !== "n") {
      write(gitignorePath, `# Dragnet local state\n${gitignoreLine}\n`);
    }
  }

  return config;
}
