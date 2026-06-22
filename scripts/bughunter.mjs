#! /usr/bin/env node
// scripts/bughunter.mjs — BugHunter CLI for OpenCode slash commands
// Usage: node scripts/bughunter.mjs <action> [args]

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function getApiKey() {
  const paths = [
    join(homedir(), ".config", "opencode", "opencode.json"),
    ".opencode/mcp.json",
    ".opencode/opencode.json",
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(readFileSync(p, "utf8"));
        const auth = cfg.mcp?.bughunter?.headers?.Authorization
          || cfg.mcpServers?.bughunter?.headers?.Authorization
          || "";
        return auth.replace(/^Bearer\s+/, "");
      } catch { /* skip */ }
    }
  }
  return process.env.GREPLOOP_API_KEY || "";
}

const BASE = process.env.GREPLOOP_URL || "http://localhost:3300";
const KEY = getApiKey();

async function api(method, params) {
  const res = await fetch(`${BASE}/api/mcp/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: method, arguments: params } }),
  });
  const data = await res.json();
  return data?.result?.content?.[0]?.text || data?.error?.message || JSON.stringify(data);
}

async function listRepos() {
  const res = await fetch(`${BASE}/api/mcp/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "prlist", arguments: { repoId: "_list_repos" } },
    }),
  });
  // prlist will fail without repoId, so fallback to /api/repos
  try {
    const r = await fetch(`${BASE}/api/repos`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const repos = await r.json();
    return repos.map(r => ({ id: r.id, name: r.name, prs: r._count?.pullRequests || 0 }));
  } catch { return []; }
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  if (!KEY) {
    console.log("Error: No API key found. Generate one in the GrepLoop UI (Settings → MCP API Keys).");
    process.exit(1);
  }

  switch (cmd) {
    case "list":
    case "ls":
    case "prs": {
      const repoId = args[0];
      if (repoId) {
        console.log(await api("prlist", { repoId }));
      } else {
        const repos = await listRepos();
        if (repos.length === 0) {
          console.log("No repos found. Register one in the GrepLoop UI.");
        } else {
          console.log("Repositories:");
          for (const r of repos) {
            console.log(`  ${r.name} (${r.id}) — ${r.prs} PRs`);
          }
          console.log("\nUsage: node scripts/bughunter.mjs list <repoId>");
        }
      }
      break;
    }

    case "review":
    case "r": {
      const number = args[0];
      if (!number) { console.log("Usage: node scripts/bughunter.mjs review <PR-number>"); process.exit(1); }
      console.log(await api("prcheck", { number }));
      break;
    }

    case "comments":
    case "c": {
      const number = args[0];
      if (!number) { console.log("Usage: node scripts/bughunter.mjs comments <PR-number>"); process.exit(1); }
      console.log(await api("prcomments", { number }));
      break;
    }

    default:
      console.log(`BugHunter CLI — Usage:
  node scripts/bughunter.mjs list [repoId]     List repos or PRs
  node scripts/bughunter.mjs review <number>    Review a PR
  node scripts/bughunter.mjs comments <number>  Get findings`);
  }
}

main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
