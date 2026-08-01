import { NextResponse } from "next/server";
import { verifyGitlabToken, findRepoByCloneUrl, gitFetch, scanRepoPrs, getOpenPrIds } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { checkDelivery } from "../../../../lib/webhookReplay";
import { admitAfkAfterTipReady, type EventPrHint } from "@/src/lib/tipReadyAfk";
import { triggerHostedScan } from "@/src/services/hostedScan/orchestrator";
import { createDeliveryLog, updateDeliveryStatus } from "../../../../lib/webhookDelivery";
import type { HostedPrData } from "@/src/services/hostedScan/orchestrator";

export async function POST(request: Request) {
  const event = request.headers.get("x-gitlab-event");
  if (!event) {
    return NextResponse.json({ error: "Missing x-gitlab-event header" }, { status: 400 });
  }

  const deliveryGuid = request.headers.get("x-gitlab-event-uuid") || "";
  const token = request.headers.get("x-gitlab-token") || "";
  const rawBody = await request.text();

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const project = payload?.project;
  if (!project) {
    return NextResponse.json({ error: "Missing project" }, { status: 400 });
  }

  const cloneUrl = project.git_http_url || project.git_ssh_url;
  if (!cloneUrl) {
    return NextResponse.json({ error: "No clone URL in payload" }, { status: 400 });
  }

  const matched = await findRepoByCloneUrl(cloneUrl);
  if (!matched) {
    return NextResponse.json({ error: "No matching repository found" }, { status: 404 });
  }

  if (matched.webhookEnabled === false) {
    return NextResponse.json({ error: "Webhook processing is disabled for this repository" }, { status: 403 });
  }

  if (!matched.webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured for this repository" }, { status: 401 });
  }
  if (!verifyGitlabToken(token, matched.webhookSecret)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  if (deliveryGuid && checkDelivery(deliveryGuid)) {
    return NextResponse.json({ error: "Duplicate delivery UUID — replay rejected" }, { status: 429 });
  }

  const triggerAfkScans = async (
    prIds: string[],
    event?: EventPrHint,
    repoForTip?: { path?: string | null; cloneUrl?: string | null },
  ): Promise<{ admitted: number; error?: string; preferredPrId?: string | null }> => {
    try {
      return await admitAfkAfterTipReady({
        repoId: matched.id,
        prIds,
        triggerReason: "webhook",
        event,
        repo: {
          id: matched.id,
          path: repoForTip?.path ?? matched.path,
          cloneUrl: repoForTip?.cloneUrl ?? matched.cloneUrl,
          cloneUrlHttps: matched.cloneUrlHttps,
          deployKeyCipher: matched.deployKeyCipher,
          deployKeyIv: matched.deployKeyIv,
          deployKeyTag: matched.deployKeyTag,
          patCipher: matched.patCipher,
          patIv: matched.patIv,
          patTag: matched.patTag,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[webhook] tip-ready AFK admit failed for ${matched.id}:`, err);
      return { admitted: 0, error: msg };
    }
  };

  const eventHintFromMr = (mr: {
    iid?: number;
    source_branch?: string;
    target_branch?: string;
    last_commit?: { id?: string };
  } | null | undefined): EventPrHint | undefined => {
    if (!mr) return undefined;
    return {
      githubPrNumber: typeof mr.iid === "number" ? mr.iid : undefined,
      sourceBranch: mr.source_branch,
      headSha: mr.last_commit?.id,
      headRef: mr.source_branch,
      baseRef: mr.target_branch,
    };
  };

  const logDelivery = deliveryGuid
    ? await createDeliveryLog({
        repoId: matched.id,
        provider: "gitlab",
        eventType: event,
        deliveryGuid,
        hostedMode: matched.hostedMode,
      })
    : null;

  const finishOk = async (
    body: Record<string, unknown>,
    deliveryStatus: "completed" | "failed" | "ignored" = "completed",
    error?: string,
  ) => {
    if (logDelivery) await updateDeliveryStatus(logDelivery, deliveryStatus, error);
    return NextResponse.json(body);
  };

  const refreshCloneAndPrs = async (): Promise<{
    prIds: string[];
    cloneError?: string;
    repoPath?: string | null;
  }> => {
    if (matched.path || matched.cloneUrl) {
      const ok = await gitFetch(matched);
      if (!ok) {
        return { prIds: [], cloneError: "git fetch failed" };
      }
      return { prIds: await scanRepoPrs(matched), repoPath: matched.path };
    }
    try {
      const localPath = await enqueue(matched.id);
      if (!localPath) {
        return { prIds: [], cloneError: "Clone/fetch already in progress" };
      }
      const ok = await gitFetch({ ...matched, path: localPath });
      if (!ok) {
        return { prIds: [], cloneError: "git fetch failed" };
      }
      return {
        prIds: await scanRepoPrs({ ...matched, path: localPath }),
        repoPath: localPath,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[webhook] enqueue failed for ${matched.id}:`, err);
      return { prIds: [], cloneError: msg };
    }
  };

  if (event === "Merge Request Hook") {
    const mr = payload.object_attributes;
    if (!mr) {
      if (logDelivery) await updateDeliveryStatus(logDelivery, "failed", "Missing merge request");
      return NextResponse.json({ error: "Missing merge request" }, { status: 400 });
    }

    if (matched.hostedMode) {
      if (!mr.source_branch || !mr.target_branch || !mr.last_commit?.id) {
        if (logDelivery) await updateDeliveryStatus(logDelivery, "failed", "Missing merge request data");
        return NextResponse.json({ error: "Missing merge request data (source_branch, target_branch, last_commit.id)" }, { status: 400 });
      }
      const prData: HostedPrData = {
        prNumber: mr.iid,
        title: mr.title || "Untitled",
        headBranch: mr.source_branch,
        baseBranch: mr.target_branch,
        commitHash: mr.last_commit.id,
        author: payload.user?.name || "webhook",
        description: mr.description || undefined,
      };
      const result = await triggerHostedScan(matched.id, prData, {
        automatic: true,
        triggerReason: "webhook",
      });
      if (!result.ok) {
        if (logDelivery) await updateDeliveryStatus(logDelivery, "failed", (result as { error: string }).error);
        return NextResponse.json({ error: (result as { error: string }).error }, { status: 400 });
      }
      if (logDelivery) await updateDeliveryStatus(logDelivery, "completed");
      return NextResponse.json({ ok: true, repo: matched.id, mr: mr.iid, hosted: true, prId: result.prId });
    }

    const { prIds, cloneError, repoPath } = await refreshCloneAndPrs();
    if (cloneError) {
      return finishOk(
        { ok: true, repo: matched.id, mr: mr.iid, afkScans: 0, error: cloneError },
        "failed",
        `clone-failed: ${cloneError}`,
      );
    }
    const eventHint = eventHintFromMr(mr);
    const { admitted: afkScans, error: afkError, preferredPrId } = await triggerAfkScans(
      prIds,
      eventHint,
      { path: repoPath ?? matched.path, cloneUrl: matched.cloneUrl },
    );
    if (afkError) {
      return finishOk(
        {
          ok: true,
          repo: matched.id,
          mr: mr.iid,
          preferredPrId: preferredPrId ?? undefined,
          afkScans,
          error: afkError,
        },
        "failed",
        afkError.startsWith("tip-ready-failed")
          ? afkError
          : `afk-admit-failed: ${afkError}`,
      );
    }
    return finishOk({
      ok: true,
      repo: matched.id,
      mr: mr.iid,
      preferredPrId: preferredPrId ?? undefined,
      afkScans,
    });
  }

  if (event === "Push Hook") {
    if (matched.hostedMode) {
      const prIds = await getOpenPrIds(matched.id);
      const { admitted: afkScans, error: afkError } = await triggerAfkScans(prIds);
      if (afkError) {
        return finishOk(
          { ok: true, repo: matched.id, hosted: true, afkScans, error: afkError },
          "failed",
          `afk-admit-failed: ${afkError}`,
        );
      }
      return finishOk(
        { ok: true, repo: matched.id, hosted: true, afkScans },
        afkScans > 0 ? "completed" : "ignored",
      );
    }

    const { prIds, cloneError, repoPath } = await refreshCloneAndPrs();
    if (cloneError) {
      return finishOk(
        { ok: true, repo: matched.id, afkScans: 0, error: cloneError },
        "failed",
        `clone-failed: ${cloneError}`,
      );
    }
    const { admitted: afkScans, error: afkError } = await triggerAfkScans(prIds, undefined, {
      path: repoPath ?? matched.path,
      cloneUrl: matched.cloneUrl,
    });
    if (afkError) {
      return finishOk(
        { ok: true, repo: matched.id, afkScans, error: afkError },
        "failed",
        afkError.startsWith("tip-ready-failed")
          ? afkError
          : `afk-admit-failed: ${afkError}`,
      );
    }
    return finishOk({ ok: true, repo: matched.id, afkScans });
  }

  if (logDelivery) await updateDeliveryStatus(logDelivery, "ignored");
  return NextResponse.json({ ok: true, ignored: true, event });
}
