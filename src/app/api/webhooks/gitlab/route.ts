import { NextResponse } from "next/server";
import { verifyGitlabToken, findRepoByCloneUrl, gitFetch, scanRepoPrs } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";

export async function POST(request: Request) {
  const event = request.headers.get("x-gitlab-event");
  if (!event) {
    return NextResponse.json({ error: "Missing x-gitlab-event header" }, { status: 400 });
  }

  const token = request.headers.get("x-gitlab-token") || "";
  const rawBody = await request.text();

  // Reject requests with no token header before any DB work — mirrors the
  // GitHub gate. Prevents unauthenticated attackers from spaming arbitrary
  // clone_url values and forcing a per-request DB scan.
  if (!token) {
    return NextResponse.json({ error: "Missing x-gitlab-token header" }, { status: 401 });
  }

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

  if (!matched.webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured for this repository" }, { status: 401 });
  }
  if (!verifyGitlabToken(token, matched.webhookSecret)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  if (event === "Merge Request Hook") {
    const mr = payload.object_attributes;
    if (!mr) {
      return NextResponse.json({ error: "Missing merge request" }, { status: 400 });
    }
    if (matched.localPath) {
      gitFetch(matched.localPath);
      await scanRepoPrs(matched.id, matched.localPath);
    } else {
      enqueue(matched.id).catch((err) => console.error(`[webhook] enqueue failed for ${matched.id}:`, err));
    }
    return NextResponse.json({ ok: true, repo: matched.id, mr: mr.iid });
  }

  if (event === "Push Hook") {
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
