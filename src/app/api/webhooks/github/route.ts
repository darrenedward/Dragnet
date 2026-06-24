import { NextResponse } from "next/server";
import { verifyGithubSignature, findRepoByCloneUrl, gitFetch, scanRepoPrs } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";

export async function POST(request: Request) {
  const event = request.headers.get("x-github-event");
  if (!event) {
    return NextResponse.json({ error: "Missing x-github-event header" }, { status: 400 });
  }

  const signature = request.headers.get("x-hub-signature-256") || "";
  const rawBody = await request.text();

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

  if (event === "pull_request" && payload.action) {
    if (matched.localPath) {
      gitFetch(matched.localPath);
      await scanRepoPrs(matched.id, matched.localPath);
    } else {
      enqueue(matched.id).catch((err) => console.error(`[webhook] enqueue failed for ${matched.id}:`, err));
    }
    return NextResponse.json({ ok: true, repo: matched.id, pr: payload.pull_request?.number });
  }

  if (event === "push") {
    if (matched.localPath) {
      gitFetch(matched.localPath);
      await scanRepoPrs(matched.id, matched.localPath);
    } else {
      enqueue(matched.id).catch((err) => console.error(`[webhook] enqueue failed for ${matched.id}:`, err));
    }
    return NextResponse.json({ ok: true, repo: matched.id });
  }

  return NextResponse.json({ ok: true, ignored: true, event });
}
