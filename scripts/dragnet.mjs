#! /usr/bin/env node
// scripts/dragnet.mjs — Dragnet CLI companion
// Usage:
//   node scripts/dragnet.mjs install-hooks         # install pre-push hook
//   node scripts/dragnet.mjs uninstall-hooks       # remove pre-push hook
//   node scripts/dragnet.mjs review <branch>       # run review, exit 0/1

const BASE = process.env.DRAGNET_URL || "http://localhost:3300";
const API_KEY = process.env.DRAGNET_REPO_KEY || process.env.DRAGNET_API_KEY || "";

const [cmd, ...args] = process.argv.slice(2);

const { execSync: _execSync } = await import("child_process");

async function main() {
  switch (cmd) {
    case "install-hooks": {
      const { execSync } = await import("child_process");
      const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
      const dst = `${root}/.git/hooks/pre-push`;
      const src = new URL("../hooks/pre-push", import.meta.url).pathname;
      execSync(`cp "${src}" "${dst}" && chmod +x "${dst}"`, { stdio: "inherit" });
      console.log(`✓ Dragnet pre-push hook installed at ${dst}`);
      break;
    }
    case "uninstall-hooks": {
      const { execSync } = await import("child_process");
      const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
      const dst = `${root}/.git/hooks/pre-push`;
      execSync(`rm -f "${dst}"`, { stdio: "inherit" });
      console.log(`✓ Dragnet pre-push hook removed from ${dst}`);
      break;
    }
    case "review": {
      const branch = args[0] || _execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      const repoPath = _execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
      const sha = _execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

      const res = await fetch(`${BASE}/api/hooks/prepush`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { "Authorization": `Bearer ${API_KEY}` } : {}) },
        body: JSON.stringify({ branch, repoPath, sha }),
      });

      const data = await res.json();
      if (data.passed) {
        console.log(`✓ Dragnet: branch "${branch}" approved (${data.rating}/10)`);
        process.exit(0);
      } else {
        console.log(`✗ Dragnet: branch "${branch}" blocked (${data.rating}/10)`);
        for (const f of data.findings || []) {
          console.log(`  [${f.severity}] ${f.filename}:${f.line} — ${f.explanation}`);
        }
        process.exit(1);
      }
      break;
    }
    case "prune-volumes": {
      const { execSync } = await import("child_process");
      const engine = process.env.CONTAINER_RUNTIME === "podman" ? "podman" : "docker";
      try {
        execSync(`${engine} --version`, { stdio: "ignore" });
      } catch {
        console.error(`${engine} is not available — cannot prune volumes.`);
        process.exit(1);
      }
      const allVolumes = execSync(`${engine} volume ls --format '{{.Name}}'`, { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter((v) => v.startsWith("dragnet-repo-"));
      if (allVolumes.length === 0) {
        console.log("No dragnet volumes found.");
        break;
      }
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      let activeIds;
      try {
        const repos = await prisma.repository.findMany({ select: { id: true } });
        activeIds = new Set(repos.map((r) => `dragnet-repo-${r.id}`));
      } finally {
        await prisma.$disconnect();
      }
      let pruned = 0;
      for (const vol of allVolumes) {
        if (activeIds.has(vol)) continue;
        try {
          execSync(`${engine} volume rm -f "${vol}"`, { stdio: "ignore" });
          console.log(`  ✓ pruned ${vol}`);
          pruned++;
        } catch (e) {
          console.warn(`  ✗ failed to prune ${vol}: ${e.message}`);
        }
      }
      console.log(`Pruned ${pruned} orphaned volume(s).`);
      break;
    }
        default:
          console.log(`Usage: dragnet <command> [options]
        
Commands:
  install-hooks         Install pre-push hook (requires API key)
  uninstall-hooks       Remove pre-push hook
  review <branch>       Run review on branch (requires API key)
  prune-volumes         Remove orphaned Docker volumes

Environment variables:
  DRAGNET_URL          Dragnet server URL (default: http://localhost:3300)
  DRAGNET_REPO_KEY     API key for authentication (generated in UI)
                        Falls back to DRAGNET_API_KEY for backward compatibility

Set these in your shell profile or .env file.`);
          process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
