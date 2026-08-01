import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { verifyGithubSignature, findRepoByCloneUrl, gitFetch, scanRepoPrs, getOpenPrIds } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { checkDelivery } from "../../../../lib/webhookReplay";
import { admitAfkAfterTipReady, type EventPrHint } from "@/src/lib/tipReadyAfk";
import { triggerHostedScan } from "@/src/services/hostedScan/orchestrator";
import { createDeliveryLog, updateDeliveryStatus } from "../../../../lib/webhookDelivery";
import type { HostedPrData } from "@/src/services/hostedScan/orchestrator";

export async function POST(request: Request) {
  const event = request.headers.get("x-github-event");
  if (!event) {
    return NextResponse.json({ error: "Missing x-github-event header" }, { status: 400 });
  }

  const deliveryGuid = request.headers.get("x-github-delivery") || "";
  const signature = request.headers.get("x-hub-signature-256") || "";
  const rawBody = await request.text();

  // Reject requests with no signature header before any DB work — without this
  // gate, an unauthenticated attacker can spam arbitrary clone_url values and
  // force a per-request DB scan of every repo's cloneUrl/localPath/webhookSecret
  // columns. Bots that don't bother forging an HMAC are turned away free; the
  // per-repo secret check below still catches attackers who do send a fake
  // signature. Full elimination would need a global DRAGNET_WEBHOOK_SECRET.
  if (!signature) {
    return NextResponse.json({ error: "Missing x-hub-signature-256 header" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const repo = payload?.repository;
  if (!repo || !repo.clone_url) {
    return NextResponse.json({ error: "Missing repository or clone_url" }, { status: 400 });
  }

  const matched = await findRepoByCloneUrl(repo.clone_url);
  if (!matched) {
    return NextResponse.json({ error: "No matching repository found" }, { status: 404 });
  }

  if (matched.webhookEnabled === false) {
    return NextResponse.json({ error: "Webhook processing is disabled for this repository" }, { status: 403 });
  }

  if (!matched.webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured for this repository" }, { status: 401 });
  }
  if (!verifyGithubSignature(rawBody, signature, matched.webhookSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (deliveryGuid && checkDelivery(deliveryGuid)) {
    return NextResponse.json({ error: "Duplicate delivery GUID — replay rejected" }, { status: 429 });
  }

  /** Tip-ready (hash + head/base fetch context) then policy-gated AFK admit. */
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

  const eventHintFromPullRequest = (pr: {
    number?: number;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  } | null | undefined): EventPrHint | undefined => {
    if (!pr) return undefined;
    return {
      githubPrNumber: typeof pr.number === "number" ? pr.number : undefined,
      sourceBranch: pr.head?.ref,
      headSha: pr.head?.sha,
      headRef: pr.head?.ref,
      baseRef: pr.base?.ref,
    };
  };

  const logDelivery = deliveryGuid
    ? await createDeliveryLog({
        repoId: matched.id,
        provider: "github",
        eventType: event,
        deliveryGuid,
        hostedMode: matched.hostedMode,
      })
    : null;

  const finishOk = async (body: Record<string, unknown>, deliveryStatus: "completed" | "failed" | "ignored" = "completed", error?: string) => {
    if (logDelivery) await updateDeliveryStatus(logDelivery, deliveryStatus, error);
    await prisma.repository.update({
      where: { id: matched.id },
      data: { lastWebhookEventAt: new Date() },
    }).catch((err) => console.error("[webhook] failed to update lastWebhookEventAt:", err));
    return NextResponse.json(body);
  };

  /** Refresh clone + PR list; on clone failure mark delivery failed (still HTTP 200). */
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

  if (event === "pull_request" && payload.action) {
    if (matched.hostedMode) {
      const pr = payload.pull_request;
      if (!pr?.head?.ref || !pr?.base?.ref || !pr?.head?.sha) {
        if (logDelivery) await updateDeliveryStatus(logDelivery, "failed", "Missing pull_request data");
        return NextResponse.json({ error: "Missing pull_request data (head.ref, base.ref, head.sha)" }, { status: 400 });
      }
      const prData: HostedPrData = {
        prNumber: pr.number,
        title: pr.title || "Untitled",
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        commitHash: pr.head.sha,
        author: pr.user?.login || "webhook",
        description: pr.body || undefined,
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
      await prisma.repository.update({
        where: { id: matched.id },
        data: { lastWebhookEventAt: new Date() },
      }).catch((err) => console.error("[webhook] failed to update lastWebhookEventAt:", err));
      return NextResponse.json({ ok: true, repo: matched.id, pr: pr.number, hosted: true, prId: result.prId });
    }

    const { prIds, cloneError, repoPath } = await refreshCloneAndPrs();
    if (cloneError) {
      return finishOk(
        { ok: true, repo: matched.id, pr: payload.pull_request?.number, afkScans: 0, error: cloneError },
        "failed",
        `clone-failed: ${cloneError}`,
      );
    }
    const eventHint = eventHintFromPullRequest(payload.pull_request);
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
          pr: payload.pull_request?.number,
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
      pr: payload.pull_request?.number,
      preferredPrId: preferredPrId ?? undefined,
      afkScans,
    });
  }

  if (event === "push") {
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
