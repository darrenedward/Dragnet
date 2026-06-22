#! /usr/bin/env node
// scripts/greploop.mjs — GrepLoop CLI companion
// Usage:
//   node scripts/greploop.mjs install-hooks   # install pre-push hook
//   node scripts/greploop.mjs review <branch>  # run review, exit 0/1

const BASE = process.env.GREPLOOP_URL || "http://localhost:3000";
const API_KEY = process.env.GREPLOOP_API_KEY || "";

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "install-hooks": {
      const { execSync } = await import("child_process");
      const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
      const dst = `${root}/.git/hooks/pre-push`;
      const src = new URL("../hooks/pre-push", import.meta.url).pathname;
      execSync(`cp "${src}" "${dst}" && chmod +x "${dst}"`, { stdio: "inherit" });
      console.log(`✓ GrepLoop pre-push hook installed at ${dst}`);
      break;
    }
    case "review": {
      const branch = args[0] || execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      const repoPath = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
      const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

      const res = await fetch(`${BASE}/api/hooks/prepush`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { "Authorization": `Bearer ${API_KEY}` } : {}) },
        body: JSON.stringify({ branch, repoPath, sha }),
      });

      const data = await res.json();
      if (data.passed) {
        console.log(`✓ GrepLoop: branch "${branch}" approved (${data.rating}/10)`);
        process.exit(0);
      } else {
        console.log(`✗ GrepLoop: branch "${branch}" blocked (${data.rating}/10)`);
        for (const f of data.findings || []) {
          console.log(`  [${f.severity}] ${f.filename}:${f.line} — ${f.explanation}`);
        }
        process.exit(1);
      }
      break;
    }
    default:
      console.log("Usage: greploop <install-hooks|review>");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
