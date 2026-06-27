import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { getRealLocalPrs } from "@/src/lib/getRealLocalPrs";
import { encryptSecret, hasMasterKey } from "@/src/lib/crypto";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { getProviderFromUrl } from "@/src/lib/webhookSetup";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

/**
 * Writes `.dragnet/repo-id` into the repo directory after registration so
 * the /dragnet skill (and CLI tools) can discover the repoId without an env
 * var or a session-authenticated API call. Mode 0600 to match the existing
 * `.dragnet/{cred,llm-presets}.json` pattern.
 *
 * Failure is non-fatal — the repo still registers. The skill will surface
 * a clear "set DRAGNET_REPO_ID" message if it can't read this file.
 */
function writeRepoIdMarker(repoPath: string, repoId: string): void {
  try {
    const dragnetDir = path.join(repoPath, ".dragnet");
    if (!fs.existsSync(dragnetDir)) {
      fs.mkdirSync(dragnetDir, { recursive: true, mode: 0o700 });
    }
    const markerPath = path.join(dragnetDir, "repo-id");
    fs.writeFileSync(markerPath, repoId + "\n", { mode: 0o600 });
  } catch (err: any) {
    console.warn(`[repos] failed to write .dragnet/repo-id marker for ${repoId}:`, err.message);
  }
}

export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const reposRaw = await prisma.repository.findMany({
      include: { _count: { select: { pullRequests: true } } },
    });
    const repos = reposRaw.map(r => ({ ...r, prCount: r._count.pullRequests }));
    return NextResponse.json(repos);
  } catch (err: any) {
    console.error("Error fetching repositories:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // Auth at the route level — the proxy.ts middleware is cookie-PRESENCE
  // only (Better Auth's getSessionCookie does not verify the signature in
  // the network boundary). Without this check, any request with a cookie
  // header (even a fake one) could register repos / trigger git clones.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const body = await req.json();
    const {
      id, name, path: repoPath,
      baseBranch, activeBranch, triggerMode, quietPeriodSeconds, branchPattern,
      mode = "local",
      cloneUrl, cloneUrlHttps, deployKey, pat,
    } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "Name is required." }, { status: 400 });
    }

    if (mode === "local") {
      if (!repoPath || typeof repoPath !== "string") {
        return NextResponse.json({ error: "Path is required for local repos." }, { status: 400 });
      }

      const existing = await prisma.repository.findFirst({
        where: { path: repoPath },
        select: { id: true, name: true },
      });
      if (existing) {
        return NextResponse.json(
          {
            error: `Directory "${repoPath}" is already linked as project "${existing.name}".`,
            existingId: existing.id,
            existingName: existing.name,
          },
          { status: 409 },
        );
      }

      const cleanId = id || name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now();

      try {
        const { execSync } = require('child_process');
        try {
          execSync('git --version', { stdio: 'ignore' });
        } catch {
          return NextResponse.json({ error: "Git is not installed or not available in the system PATH. Please install Git to use local repositories." }, { status: 400 });
        }
        
        const fs = require('fs');
        if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
          return NextResponse.json({ error: `Directory "${repoPath}" does not exist on disk.` }, { status: 400 });
        }

        try {
          execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, stdio: 'ignore' });
        } catch {
          return NextResponse.json({ error: `Directory "${repoPath}" is not a valid git repository. Please run 'git init' inside the directory first.` }, { status: 400 });
        }
      } catch (err: any) {
        return NextResponse.json({ error: "Failed to validate git repository: " + err.message }, { status: 500 });
      }

      try {
        await prisma.repository.create({
          data: {
            id: cleanId,
            name,
            path: repoPath,
            provider: "local",
            baseBranch: baseBranch || "main",
            activeBranch: activeBranch || baseBranch || "main",
            triggerMode: triggerMode || "auto",
            quietPeriodSeconds: quietPeriodSeconds || 10,
            branchPattern: branchPattern || "*",
            status: "idle",
            lastCommitHash: "a1b2c3d",
            lastCommitMessage: "initial repository watch link",
            lastActivityTime: new Date().toISOString(),
            stabilizationTimer: 0,
            reviewsCount: 0,
          },
        });
      } catch (createErr: any) {
        if (createErr?.code === "P2002") {
          const racer = await prisma.repository.findFirst({
            where: { path: repoPath },
            select: { id: true, name: true },
          });
          return NextResponse.json(
            {
              error: `Directory "${repoPath}" was just linked as project "${racer?.name || "unknown"}" — duplicate prevented.`,
              existingId: racer?.id,
              existingName: racer?.name,
            },
            { status: 409 },
          );
        }
        throw createErr;
      }

      await getRealLocalPrs(repoPath, cleanId);
      writeRepoIdMarker(repoPath, cleanId);
      return NextResponse.json({ success: true, id: cleanId }, { status: 201 });
    }

    // --- Remote repo (ssh or pat) ---
    if (!cloneUrl || typeof cloneUrl !== "string") {
      return NextResponse.json({ error: "cloneUrl is required for remote repos." }, { status: 400 });
    }

    // Reject cloneUrl that isn't HTTPS or SSH user@host:path form.
    // Without this, an attacker could submit "git@evil.com:foo/bar" and
    // the server would attempt to clone it during remoteFetchWorker.enqueue,
    // leaking the deployKey to a malicious SSH endpoint. Also reject
    // null bytes / control chars anywhere in the path or URL.
    const HTTPS_URL_RE = /^https:\/\/[a-zA-Z0-9.-]+\/.+$/;
    const SSH_URL_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:.+$/;
    if (!HTTPS_URL_RE.test(cloneUrl) && !SSH_URL_RE.test(cloneUrl)) {
      return NextResponse.json(
        { error: "cloneUrl must be HTTPS (https://host/path) or SSH (user@host:path). Other schemes are rejected to prevent credential leakage." },
        { status: 400 },
      );
    }
    if (/[\0-\x1f]/.test(cloneUrl) || (typeof repoPath === "string" && /[\0-\x1f]/.test(repoPath))) {
      return NextResponse.json({ error: "Invalid characters in cloneUrl or repoPath." }, { status: 400 });
    }

    if (mode === "ssh" && (!deployKey || typeof deployKey !== "string")) {
      return NextResponse.json({ error: "deployKey is required for SSH mode." }, { status: 400 });
    }

    if (mode === "pat" && (!pat || typeof pat !== "string")) {
      return NextResponse.json({ error: "PAT is required for PAT mode." }, { status: 400 });
    }

    if (!hasMasterKey()) {
      return NextResponse.json(
        { error: "DRAGNET_MASTER_KEY is not set. Remote repo secrets cannot be encrypted." },
        { status: 500 },
      );
    }

    const cleanId = id || name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now();
    const provider = getProviderFromUrl(cloneUrl, cloneUrlHttps);
    const webhookSecret = crypto.randomUUID();

    const encryptOpts: Record<string, string | undefined> = {};
    if (deployKey) {
      const { cipher, iv, tag } = encryptSecret(deployKey);
      encryptOpts.deployKeyCipher = cipher;
      encryptOpts.deployKeyIv = iv;
      encryptOpts.deployKeyTag = tag;
    }
    if (pat) {
      const { cipher, iv, tag } = encryptSecret(pat);
      encryptOpts.patCipher = cipher;
      encryptOpts.patIv = iv;
      encryptOpts.patTag = tag;
    }

    try {
      await prisma.repository.create({
        data: {
          id: cleanId,
          name,
          path: null,
          provider,
          cloneUrl,
          cloneUrlHttps: cloneUrlHttps || null,
          webhookSecret,
          baseBranch: baseBranch || "main",
          activeBranch: activeBranch || baseBranch || "main",
          triggerMode: triggerMode || "auto",
          quietPeriodSeconds: quietPeriodSeconds || 10,
          branchPattern: branchPattern || "*",
          status: "cloning",
          lastCommitHash: "",
          lastCommitMessage: "",
          lastActivityTime: new Date().toISOString(),
          stabilizationTimer: 0,
          reviewsCount: 0,
          ...encryptOpts,
        },
      });
    } catch (createErr: any) {
      if (createErr?.code === "P2002") {
        return NextResponse.json(
          { error: `Repository "${name}" was just linked — duplicate prevented.` },
          { status: 409 },
        );
      }
      throw createErr;
    }

    enqueue(cleanId).catch((err) => {
      console.error(`[repos] initial fetch failed for ${cleanId}:`, err);
      prisma.repository.update({ where: { id: cleanId }, data: { status: "error" } }).catch(() => {});
    });

    return NextResponse.json({ success: true, id: cleanId, webhookSecret }, { status: 201 });
  } catch (err: any) {
    console.error("Error inserting repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
