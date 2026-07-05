import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { verifyGithubSignature, verifyReplayAttack, findRepoByCloneUrl, gitFetch, scanRepoPrs } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";

export async function POST(request: Request) {
  const deliveryGuid = request.headers.get("x-github-delivery") || "";
  if (!deliveryGuid) {
    return NextResponse.json({ error: "Missing x-github-delivery header" }, { status: 400 });
  }
  if (!verifyReplayAttack(deliveryGuid)) {
    return NextResponse.json({ error: "Replay attack detected" }, { status: 429 });
  }

  const event = request.headers.get("x-github-event");
  if (!event) {
    return NextResponse.json({ error: "Missing x-github-event header" }, { status: 400 });
  }

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

  // Only record delivery timestamp and enqueue for known events
  if (event === "pull_request" && payload.action) {
    if (matched.localPath) {
      gitFetch(matched.localPath);
      await scanRepoPrs(matched.id, matched.localPath);
    } else {
      enqueue(matched.id).catch((err) => console.error(`[webhook] enqueue failed for ${matched.id}:`, err));
    }
    await prisma.repository.update({
      where: { id: matched.id },
      data: { lastWebhookEventAt: new Date() },
    }).catch((err) => console.error("[webhook] failed to update lastWebhookEventAt:", err));
    return NextResponse.json({ ok: true, repo: matched.id, pr: payload.pull_request?.number });
  }

  if (event === "push") {
    if (matched.localPath) {
      gitFetch(matched.localPath);
      await scanRepoPrs(matched.id, matched.localPath);
    } else {
      enqueue(matched.id).catch((err) => console.error(`[webhook] enqueue failed for ${matched.id}:`, err));
    }
    await prisma.repository.update({
      where: { id: matched.id },
      data: { lastWebhookEventAt: new Date() },
    }).catch((err) => console.error("[webhook] failed to update lastWebhookEventAt:", err));
    return NextResponse.json({ ok: true, repo: matched.id });
  }

  return NextResponse.json({ ok: true, ignored: true, event });
}
