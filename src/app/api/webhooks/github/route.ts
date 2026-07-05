import { NextResponse } from "next/server";
import { verifyGithubSignature, findRepoByCloneUrl, gitFetch, scanRepoPrs } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { checkDelivery } from "../../../../lib/webhookReplay";
import { runPrScan } from "../../../../../reviewService";

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
      runPrScan(prId).catch((err) =>
        console.error(`[webhook] AFK scan failed for ${prId}:`, err),
      );
    }
  };

  if (event === "pull_request" && payload.action) {
    const prIds: string[] = [];
    if (matched.localPath) {
      gitFetch(matched.localPath);
      const ids = await scanRepoPrs(matched.id, matched.localPath);
      prIds.push(...ids);
    } else {
      const localPath = await enqueue(matched.id).catch((err) => {
        console.error(`[webhook] enqueue failed for ${matched.id}:`, err);
        return null;
      });
      if (localPath) {
        gitFetch(localPath);
        const ids = await scanRepoPrs(matched.id, localPath);
        prIds.push(...ids);
      }
    }
    triggerAfkScans(prIds);
    return NextResponse.json({ ok: true, repo: matched.id, pr: payload.pull_request?.number, afkScans: prIds.length });
  }

  if (event === "push") {
    const prIds: string[] = [];
    if (matched.localPath) {
      gitFetch(matched.localPath);
      const ids = await scanRepoPrs(matched.id, matched.localPath);
      prIds.push(...ids);
    } else {
      const localPath = await enqueue(matched.id).catch((err) => {
        console.error(`[webhook] enqueue failed for ${matched.id}:`, err);
        return null;
      });
      if (localPath) {
        gitFetch(localPath);
        const ids = await scanRepoPrs(matched.id, localPath);
        prIds.push(...ids);
      }
    }
    triggerAfkScans(prIds);
    return NextResponse.json({ ok: true, repo: matched.id, afkScans: prIds.length });
  }

  return NextResponse.json({ ok: true, ignored: true, event });
}
