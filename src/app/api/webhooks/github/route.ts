import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { verifyGithubSignature, findRepoByCloneUrl, gitFetch, scanRepoPrs, getOpenPrIds } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { checkDelivery } from "../../../../lib/webhookReplay";
import { admitScanJobForPr } from "@/src/services/scanQueue";
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

  const triggerAfkScans = (prIds: string[]) => {
    for (const prId of prIds) {
      admitScanJobForPr({ prId, triggerReason: "webhook" }).catch((err) =>
        console.error(`[webhook] AFK scan failed for ${prId}:`, err),
      );
    }
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
      const result = await triggerHostedScan(matched.id, prData);
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

    const prIds: string[] = [];
    if (matched.path || matched.cloneUrl) {
      await gitFetch(matched);
      const ids = await scanRepoPrs(matched);
      prIds.push(...ids);
    } else {
      const localPath = await enqueue(matched.id).catch((err) => {
        console.error(`[webhook] enqueue failed for ${matched.id}:`, err);
        return null;
      });
      if (localPath) {
        await gitFetch({ ...matched, path: localPath });
        const ids = await scanRepoPrs({ ...matched, path: localPath });
        prIds.push(...ids);
      }
    }
    triggerAfkScans(prIds);
    if (logDelivery) await updateDeliveryStatus(logDelivery, "completed");
    await prisma.repository.update({
      where: { id: matched.id },
      data: { lastWebhookEventAt: new Date() },
    }).catch((err) => console.error("[webhook] failed to update lastWebhookEventAt:", err));
    return NextResponse.json({ ok: true, repo: matched.id, pr: payload.pull_request?.number, afkScans: prIds.length });
  }

  if (event === "push") {
    if (matched.hostedMode) {
      const prIds = await getOpenPrIds(matched.id);
      for (const prId of prIds) {
        admitScanJobForPr({ prId, triggerReason: "webhook" }).catch((err) =>
          console.error(`[webhook] hosted push scan failed for ${prId}:`, err),
        );
      }
      if (logDelivery) await updateDeliveryStatus(logDelivery, prIds.length > 0 ? "completed" : "ignored");
      await prisma.repository.update({
        where: { id: matched.id },
        data: { lastWebhookEventAt: new Date() },
      }).catch((err) => console.error("[webhook] failed to update lastWebhookEventAt:", err));
      return NextResponse.json({ ok: true, repo: matched.id, hosted: true, afkScans: prIds.length });
    }

    const prIds: string[] = [];
    if (matched.path || matched.cloneUrl) {
      await gitFetch(matched);
      const ids = await scanRepoPrs(matched);
      prIds.push(...ids);
    } else {
      const localPath = await enqueue(matched.id).catch((err) => {
        console.error(`[webhook] enqueue failed for ${matched.id}:`, err);
        return null;
      });
      if (localPath) {
        await gitFetch({ ...matched, path: localPath });
        const ids = await scanRepoPrs({ ...matched, path: localPath });
        prIds.push(...ids);
      }
    }
    triggerAfkScans(prIds);
    if (logDelivery) await updateDeliveryStatus(logDelivery, "completed");
    await prisma.repository.update({
      where: { id: matched.id },
      data: { lastWebhookEventAt: new Date() },
    }).catch((err) => console.error("[webhook] failed to update lastWebhookEventAt:", err));
    return NextResponse.json({ ok: true, repo: matched.id, afkScans: prIds.length });
  }

  if (logDelivery) await updateDeliveryStatus(logDelivery, "ignored");
  return NextResponse.json({ ok: true, ignored: true, event });
}
