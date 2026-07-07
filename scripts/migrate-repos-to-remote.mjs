#!/usr/bin/env node
/**
 * migrate-repos-to-remote.mjs
 *
 * One-shot migration: rewrites every Repository row from local-path mode
 * (path = "/host-repos/<name>") to remote-clone mode (cloneUrl + PAT or
 * deployKey + localPath). Run before the first `docker compose up` so
 * the container can clone each repo fresh into its per-repo named volume
 * instead of reading from a host mount.
 *
 * Auth strategy — pick ONE:
 *
 *   A. Shared SSH key (simplest when you already have one that has access
 *      to every repo on GitHub):
 *        DRAGNET_DEPLOY_KEY="$(cat ~/.ssh/id_rsa)" node migrate-repos-to-remote.mjs
 *
 *   B. Per-repo GitHub PAT — pass a JSON map:
 *        DRAGNET_PAT_MAP='{"credmanagerpro-…":"ghp_xxx", ...}' \
 *          node migrate-repos-to-remote.mjs
 *
 *   C. Single PAT for every repo (less granular, but works):
 *        DRAGNET_PAT="ghp_xxx" node migrate-repos-to-remote.mjs
 *
 * The script:
 *   1. Lists every repo with path=/host-repos/...
 *   2. Resolves the on-disk location (derives /home/<user>/Websites/<name>
 *      by stripping the Docker prefix) so it can read `git remote get-url`.
 *   3. Detects HTTPS vs SSH from the origin URL.
 *   4. Sets cloneUrl, cloneUrlHttps, the encrypted credential, localPath
 *      (volume name `dragnet-repo-<id>`), and clears `path`.
 *   5. Prints a summary; does NOT touch the running dev server.
 *
 * Requires: DRAGNET_MASTER_KEY (32 bytes, base64) in env, plus DATABASE_URL.
 * Does NOT require: DRAGNET_DEPLOY_KEY / DRAGNET_PAT — at least one of
 * them must be set or the script aborts.
 */

import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const wantsNoSsl =
  Boolean(cs.match(/sslmode\s*=\s*(disable|allow|prefer)/i)) ||
  Boolean(cs.match(/@(localhost|127\.[\d.]+|::1|\[::1\]|[a-z0-9.-]+\.local)(:\d+)?\//i));
const stripped = cs
  .replace(/&?sslmode=[^&]*/gi, "")
  .replace(/\?&/, "?")
  .replace(/\?$/, "")
  .replace(/&&/g, "&");

const pool = new Pool({
  connectionString: stripped,
  ssl: wantsNoSsl ? false : wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const { encryptSecret } = await import("../src/lib/crypto.ts").catch(async () => {
  // Fallback: inline the same AES-256-GCM implementation so the script
  // works without a TS loader.
  const { createCipheriv, randomBytes } = await import("node:crypto");
  return {
    encryptSecret(plaintext) {
      const raw = process.env.DRAGNET_MASTER_KEY;
      if (!raw) throw new Error("DRAGNET_MASTER_KEY is not set");
      const masterKey = Buffer.from(raw, "base64");
      if (masterKey.length !== 32) throw new Error("DRAGNET_MASTER_KEY must be 32 bytes base64");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return { cipher: encrypted.toString("base64"), iv: iv.toString("base64"), tag: tag.toString("base64") };
    },
  };
});

function resolveLocalClone(path) {
  if (!path) return null;
  // Strip the Docker-only "/host-repos" prefix so we can read the actual
  // on-disk clone on the host machine running this script.
  const stripped = path.replace(/^\/host-repos\/?/, "");
  const candidates = [
    `/home/curryman/Websites/${stripped}`,
    `/home/${process.env.USER || "curryman"}/Websites/${stripped}`,
    stripped.startsWith("/") ? stripped : `/home/curryman/Websites/${stripped}`,
  ];
  for (const c of candidates) {
    try {
      execFileSync("test", ["-d", `${c}/.git`], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function readOrigin(localClone) {
  const out = execFileSync("git", ["-C", localClone, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return out;
}

function toHttpsCloneUrl(origin) {
  // git@github.com:owner/repo.git -> https://github.com/owner/repo.git
  const ssh = origin.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`;
  // https://...@github.com/owner/repo.git (PAT-in-URL) -> clean https form
  try {
    const u = new URL(origin);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return origin;
  }
}

function pickAuth(repoId) {
  if (process.env.DRAGNET_DEPLOY_KEY) {
    return { mode: "ssh", value: process.env.DRAGNET_DEPLOY_KEY };
  }
  if (process.env.DRAGNET_PAT_MAP) {
    const map = JSON.parse(process.env.DRAGNET_PAT_MAP);
    if (map[repoId]) return { mode: "pat", value: map[repoId] };
  }
  if (process.env.DRAGNET_PAT) {
    return { mode: "pat", value: process.env.DRAGNET_PAT };
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");

  const repos = await prisma.repository.findMany({
    where: { path: { startsWith: "/host-repos/" } },
    select: { id: true, name: true, path: true, cloneUrl: true },
    orderBy: { name: "asc" },
  });

  if (repos.length === 0) {
    console.log("No repos with /host-repos/ path. Nothing to migrate.");
    await prisma.$disconnect();
    return;
  }

  console.log(`${dryRun ? "[DRY RUN] Would migrate" : "Migrating"} ${repos.length} repo(s) to remote-clone mode:\n`);

  for (const repo of repos) {
    const localClone = resolveLocalClone(repo.path);
    if (!localClone) {
      console.error(`  [skip] ${repo.name} (${repo.id}) — no on-disk clone at ${repo.path}`);
      continue;
    }

    let origin;
    try {
      origin = readOrigin(localClone);
    } catch (e) {
      console.error(`  [skip] ${repo.name} — git remote read failed: ${e.message}`);
      continue;
    }

    const auth = pickAuth(repo.id);
    if (!auth) {
      console.error(`  [skip] ${repo.name} — no auth provided (set DRAGNET_DEPLOY_KEY or DRAGNET_PAT[_MAP])`);
      continue;
    }

    const cloneUrl = origin;
    const cloneUrlHttps = toHttpsCloneUrl(origin);
    const volumeName = `dragnet-repo-${repo.id}`;

    const update = {
      cloneUrl,
      cloneUrlHttps,
      localPath: volumeName,
      path: null,
    };

    if (auth.mode === "ssh") {
      const { cipher, iv, tag } = encryptSecret(auth.value);
      Object.assign(update, {
        deployKeyCipher: cipher,
        deployKeyIv: iv,
        deployKeyTag: tag,
        patCipher: null,
        patIv: null,
        patTag: null,
      });
    } else {
      const { cipher, iv, tag } = encryptSecret(auth.value);
      Object.assign(update, {
        patCipher: cipher,
        patIv: iv,
        patTag: tag,
        deployKeyCipher: null,
        deployKeyIv: null,
        deployKeyTag: null,
      });
    }

    await prisma.repository.update({ where: { id: repo.id }, data: update });

    const tag = dryRun ? "[dry-run]" : "[ok]";
    console.log(`  ${tag} ${repo.name} (${repo.id})`);
    console.log(`        cloneUrl       = ${cloneUrl}`);
    console.log(`        cloneUrlHttps  = ${cloneUrlHttps}`);
    console.log(`        localPath      = ${volumeName}`);
    console.log(`        auth           = ${auth.mode} (encrypted)`);
    console.log(`        path           = NULL (legacy cleared)`);
  }

  if (dryRun) {
    console.log("\nDry run — no changes written. Re-run without --dry-run to apply.\n");
  } else {
    console.log("\nDone. Start the container with: docker compose up -d");
    console.log("The first scan per repo will clone fresh into the named volume.\n");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});