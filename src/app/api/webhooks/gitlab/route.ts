import { NextResponse } from "next/server";
import { verifyGitlabToken, findRepoByCloneUrl, gitFetch, scanRepoPrs } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { checkDelivery } from "../../../../lib/webhookReplay";
import { runPrScan } from "../../../../../reviewService";

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

  if (!matched.webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured for this repository" }, { status: 401 });
  }
  if (!verifyGitlabToken(token, matched.webhookSecret)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  if (deliveryGuid && checkDelivery(deliveryGuid)) {
    return NextResponse.json({ error: "Duplicate delivery UUID — replay rejected" }, { status: 429 });
  }

  const triggerAfkScans = (prIds: string[]) => {
    for (const prId of prIds) {
      runPrScan(prId).catch((err) =>
        console.error(`[webhook] AFK scan failed for ${prId}:`, err),
      );
    }
  };

  if (event === "Merge Request Hook") {
    const mr = payload.object_attributes;
    if (!mr) {
      return NextResponse.json({ error: "Missing merge request" }, { status: 400 });
    }
    const prIds: string[] = [];
    if (matched.localPath) {
      gitFetch(matched.localPath);
      const ids = await scanRepoPrs(matched.id, matched.localPath);
      prIds.push(...ids);
    } else {
      enqueue(matched.id).catch((err) => console.error(`[webhook] enqueue failed for ${matched.id}:`, err));
    }
    triggerAfkScans(prIds);
    return NextResponse.json({ ok: true, repo: matched.id, mr: mr.iid, afkScans: prIds.length });
  }

  if (event === "Push Hook") {
    const prIds: string[] = [];
    if (matched.localPath) {
      gitFetch(matched.localPath);
      const ids = await scanRepoPrs(matched.id, matched.localPath);
      prIds.push(...ids);
    } else {
      enqueue(matched.id).catch((err) => console.error(`[webhook] enqueue failed for ${matched.id}:`, err));
    }
    triggerAfkScans(prIds);
    return NextResponse.json({ ok: true, repo: matched.id, afkScans: prIds.length });
  }

  return NextResponse.json({ ok: true, ignored: true, event });
}
