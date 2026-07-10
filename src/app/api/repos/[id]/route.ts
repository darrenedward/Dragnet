import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { encryptSecret, hasMasterKey } from "@/src/lib/crypto";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { getProviderFromUrl } from "@/src/lib/webhookSetup";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexing";
import { ContainerOrchestrator } from "@/src/lib/containerOrchestrator";

/** Named Docker volume for a given repo. Must match the convention in
 *  gitService.ts and ContainerOrchestrator usage. */
function volumeName(repoId: string): string {
  return `dragnet-repo-${repoId}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;

    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });

    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository record not found" }, { status: 404 });
    }

    const repoKey = await prisma.apiKey.findFirst({
      where: { repoId: id, revoked: false },
      select: { prefix: true },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      ...repo,
      apiKeyPrefix: repoKey?.prefix || null,
    });
  } catch (err: any) {
    console.error("Error fetching repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    const body = await req.json();
    const {
      activeBranch,
      status,
      lastCommitHash,
      lastCommitMessage,
      stabilizationTimer,
      reviewsCount,
      triggerMode,
      quietPeriodSeconds,
      branchPattern,
      path: repoPath,
      mode,
      cloneUrl,
      cloneUrlHttps,
      deployKey,
      pat,
      runnerImage,
      installCommand,
      testCommand,
      isPollingEnabled,
      webhookEnabled,
      skipTier2,
      hostedMode,
    } = body;

    const current = await prisma.repository.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "Repository record not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {
      lastActivityTime: new Date().toISOString(),
    };

    if (activeBranch !== undefined) updateData.activeBranch = activeBranch;
    if (status !== undefined) updateData.status = status;
    if (lastCommitHash !== undefined) updateData.lastCommitHash = lastCommitHash;
    if (lastCommitMessage !== undefined) updateData.lastCommitMessage = lastCommitMessage;
    if (stabilizationTimer !== undefined) updateData.stabilizationTimer = stabilizationTimer;
    if (reviewsCount !== undefined) updateData.reviewsCount = reviewsCount;
    if (triggerMode !== undefined) updateData.triggerMode = triggerMode;
    if (quietPeriodSeconds !== undefined) updateData.quietPeriodSeconds = quietPeriodSeconds;
    if (branchPattern !== undefined) updateData.branchPattern = branchPattern;
    if (runnerImage !== undefined) updateData.runnerImage = runnerImage;
    if (installCommand !== undefined) updateData.installCommand = installCommand;
    if (testCommand !== undefined) updateData.testCommand = testCommand;
    if (isPollingEnabled !== undefined) updateData.isPollingEnabled = Boolean(isPollingEnabled);
    if (webhookEnabled !== undefined) updateData.webhookEnabled = Boolean(webhookEnabled);
    if (skipTier2 !== undefined) updateData.skipTier2 = Boolean(skipTier2);
    if (hostedMode !== undefined) updateData.hostedMode = Boolean(hostedMode);

    const modeChanged = typeof mode === "string" && mode !== current.provider;
    const urlChanged =
      (typeof cloneUrl === "string" && cloneUrl !== current.cloneUrl) ||
      (typeof cloneUrlHttps === "string" && cloneUrlHttps !== (current.cloneUrlHttps || ""));
    const pathChanged = typeof repoPath === "string" && repoPath !== current.path;

    if (pathChanged) {
      updateData.path = repoPath;
    }

    if (modeChanged) {
      updateData.provider = mode;
      if (mode === "ssh") {
        updateData.patCipher = null;
        updateData.patIv = null;
        updateData.patTag = null;
      } else if (mode === "pat") {
        updateData.deployKeyCipher = null;
        updateData.deployKeyIv = null;
        updateData.deployKeyTag = null;
      }
    }

    if (typeof cloneUrl === "string" && cloneUrl !== current.cloneUrl) {
      const HTTPS_URL_RE = /^https:\/\/[a-zA-Z0-9.-]+\/.+$/;
      const SSH_URL_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:.+$/;
      if (cloneUrl && !HTTPS_URL_RE.test(cloneUrl) && !SSH_URL_RE.test(cloneUrl)) {
        return NextResponse.json(
          { error: "cloneUrl must be HTTPS (https://host/path) or SSH (user@host:path)." },
          { status: 400 },
        );
      }
      if (cloneUrl && /[\0-\x1f]/.test(cloneUrl)) {
        return NextResponse.json({ error: "Invalid characters in cloneUrl." }, { status: 400 });
      }
      updateData.cloneUrl = cloneUrl;
    }
    if (typeof cloneUrlHttps === "string" && cloneUrlHttps !== (current.cloneUrlHttps || "")) {
      updateData.cloneUrlHttps = cloneUrlHttps || null;
    }
    if (cloneUrl || cloneUrlHttps) {
      const newProvider = getProviderFromUrl(cloneUrl || current.cloneUrl || "", cloneUrlHttps || undefined);
      if (newProvider && newProvider !== current.provider) {
        updateData.provider = newProvider;
      }
    }

    const writingSecret = Boolean(deployKey || pat);
    if (writingSecret && !hasMasterKey()) {
      return NextResponse.json(
        { error: "DRAGNET_MASTER_KEY is not set. Cannot encrypt secrets." },
        { status: 500 },
      );
    }

    if (typeof deployKey === "string" && deployKey.length > 0) {
      const { cipher, iv, tag } = encryptSecret(deployKey);
      updateData.deployKeyCipher = cipher;
      updateData.deployKeyIv = iv;
      updateData.deployKeyTag = tag;
    }
    if (typeof pat === "string" && pat.length > 0) {
      const { cipher, iv, tag } = encryptSecret(pat);
      updateData.patCipher = cipher;
      updateData.patIv = iv;
      updateData.patTag = tag;
    }

    const targetProvider = (updateData.provider as string) || current.provider;
    const remoteTouched =
      targetProvider !== "local" && (modeChanged || urlChanged || writingSecret);

    await prisma.repository.update({ where: { id }, data: updateData });

    const targetStatus = status !== undefined ? status : current.status;
    const targetBranch = activeBranch !== undefined ? activeBranch : current.activeBranch;
    if (targetStatus === "stabilizing" && targetBranch) {
      const prId = `real-pr-${id}-${targetBranch.replace(/\//g, "-")}`;
      await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: "In Progress" } });
    }

    if (remoteTouched) {
      enqueue(id).catch((err) => {
        console.error(`[repos PUT] re-fetch failed for ${id}:`, err);
        prisma.repository.update({ where: { id }, data: { status: "error" } }).catch(() => {});
      });
    }

    return NextResponse.json({ success: true, refetched: remoteTouched });
  } catch (err: any) {
    console.error("Error updating repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    await IndexingService.clearIndex(id);
    await prisma.repository.deleteMany({ where: { id } });

    // Best-effort: prune the Docker/Podman volume that was backing this repo.
    // Non-fatal — the repo is already removed from the DB; a dangling volume
    // can be cleaned up via `npm run dragnet prune-volumes`.
    ContainerOrchestrator.getInstance()
      .deleteVolume(volumeName(id))
      .catch((err) =>
        console.warn(`[repos DELETE] volume prune failed for ${id}:`, err.message),
      );

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error unlinking repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
