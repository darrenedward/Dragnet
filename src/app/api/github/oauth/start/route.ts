import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { requireSession } from "@/src/lib/api-auth";
import { storeCsrfToken } from "@/src/lib/oauthState";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

export async function GET(req: Request) {
  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GitHub App not configured. Set GITHUB_APP_CLIENT_ID in .env.local." },
      { status: 500 },
    );
  }

  const csrf = crypto.randomBytes(32).toString("hex");
  storeCsrfToken(session.user.id, csrf);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${process.env.APP_URL || "http://localhost:3300"}/api/github/oauth/callback`,
    scope: "repo,read:org,admin:repo_hooks",
    state: csrf,
  });

  return NextResponse.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
}
