import { NextResponse } from "next/server";
import { findRepoByCloneUrl, gitFetch, scanRepoPrs } from "../../../../lib/webhook";

export async function POST(request: Request) {
  const event = request.headers.get("x-gitlab-event");
  if (!event) {
    return NextResponse.json({ error: "Missing x-gitlab-event header" }, { status: 400 });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (event === "Merge Request Hook") {
    const mr = payload.object_attributes;
    const project = payload.project;
    if (!mr || !project) {
      return NextResponse.json({ error: "Missing merge request or project" }, { status: 400 });
    }

    const cloneUrl = project.git_http_url || project.git_ssh_url;
    if (!cloneUrl) {
      return NextResponse.json({ error: "No clone URL in payload" }, { status: 400 });
    }

    const matched = await findRepoByCloneUrl(cloneUrl);
    if (!matched) {
      return NextResponse.json({ error: "No matching repository found" }, { status: 404 });
    }

    gitFetch(matched.path);
    await scanRepoPrs(matched.id, matched.path);

    return NextResponse.json({ ok: true, repo: matched.id, mr: mr.iid });
  }

  if (event === "Push Hook") {
    const project = payload.project;
    if (!project) return NextResponse.json({ error: "Missing project" }, { status: 400 });

    const cloneUrl = project.git_http_url || project.git_ssh_url;
    if (!cloneUrl) {
      return NextResponse.json({ error: "No clone URL in payload" }, { status: 400 });
    }

    const matched = await findRepoByCloneUrl(cloneUrl);
    if (!matched) {
      return NextResponse.json({ error: "No matching repository found" }, { status: 404 });
    }

    gitFetch(matched.path);
    await scanRepoPrs(matched.id, matched.path);

    return NextResponse.json({ ok: true, repo: matched.id });
  }

  return NextResponse.json({ ok: true, ignored: true, event });
}
