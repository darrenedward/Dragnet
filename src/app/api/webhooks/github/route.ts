import { NextResponse } from "next/server";
import { findRepoByCloneUrl, gitFetch, scanRepoPrs } from "../../../../lib/webhook";

export async function POST(request: Request) {
  const event = request.headers.get("x-github-event");
  if (!event) {
    return NextResponse.json({ error: "Missing x-github-event header" }, { status: 400 });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (event === "pull_request" && payload.action) {
    const pr = payload.pull_request;
    const repo = payload.repository;
    if (!pr || !repo) {
      return NextResponse.json({ error: "Missing pull_request or repository" }, { status: 400 });
    }

    const matched = await findRepoByCloneUrl(repo.clone_url);
    if (!matched) {
      return NextResponse.json({ error: "No matching repository found" }, { status: 404 });
    }

    gitFetch(matched.path);
    await scanRepoPrs(matched.id, matched.path);

    return NextResponse.json({ ok: true, repo: matched.id, pr: pr.number });
  }

  if (event === "push") {
    const repo = payload.repository;
    if (!repo) return NextResponse.json({ error: "Missing repository" }, { status: 400 });

    const matched = await findRepoByCloneUrl(repo.clone_url);
    if (!matched) {
      return NextResponse.json({ error: "No matching repository found" }, { status: 404 });
    }

    gitFetch(matched.path);
    await scanRepoPrs(matched.id, matched.path);

    return NextResponse.json({ ok: true, repo: matched.id });
  }

  return NextResponse.json({ ok: true, ignored: true, event });
}
