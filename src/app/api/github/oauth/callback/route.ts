import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { encryptSecret, hasMasterKey } from "@/src/lib/crypto";
import { requireSession } from "@/src/lib/api-auth";
import { consumeCsrfToken } from "@/src/lib/oauthState";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  if (errorParam) {
    return NextResponse.redirect(
      new URL(`/?github_oauth=error&reason=${encodeURIComponent(errorParam)}`, process.env.APP_URL || "http://localhost:3300"),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/?github_oauth=error&reason=missing_params", process.env.APP_URL || "http://localhost:3300"),
    );
  }

  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "GitHub App not configured." }, { status: 500 });
  }

  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.redirect(
      new URL("/?github_oauth=error&reason=no_session", process.env.APP_URL || "http://localhost:3300"),
    );
  }

  if (!consumeCsrfToken(session.user.id, state)) {
    return NextResponse.redirect(
      new URL("/?github_oauth=error&reason=invalid_state", process.env.APP_URL || "http://localhost:3300"),
    );
  }

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    console.error("[oauth/callback] token exchange failed:", tokenRes.status, body);
    return NextResponse.redirect(
      new URL("/?github_oauth=error&reason=token_exchange_failed", process.env.APP_URL || "http://localhost:3300"),
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error) {
    console.error("[oauth/callback] GitHub error:", tokenData.error, tokenData.error_description);
    return NextResponse.redirect(
      new URL(`/?github_oauth=error&reason=${encodeURIComponent(tokenData.error_description || tokenData.error)}`, process.env.APP_URL || "http://localhost:3300"),
    );
  }

  // Fetch the installations for this token
  const instRes = await fetch("https://api.github.com/user/installations", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!instRes.ok) {
    const body = await instRes.text().catch(() => "");
    console.error("[oauth/callback] installations fetch failed:", instRes.status, body);
    return NextResponse.redirect(
      new URL("/?github_oauth=error&reason=installations_fetch_failed", process.env.APP_URL || "http://localhost:3300"),
    );
  }

  const instData = (await instRes.json()) as {
    installations: Array<{ id: number }>;
  };

  if (!instData.installations || instData.installations.length === 0) {
    return NextResponse.redirect(
      new URL("/?github_oauth=error&reason=no_installations", process.env.APP_URL || "http://localhost:3300"),
    );
  }

  const installationId = String(instData.installations[0].id);

  // Fetch repos for this installation
  const reposRes = await fetch(
    `https://api.github.com/user/installations/${installationId}/repositories`,
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  const reposData = reposRes.ok
    ? ((await reposRes.json()) as { repositories: Array<{ id: number; full_name: string }> })
    : { repositories: [] };

  // Encrypt and store the App private key if configured in env
  let appPrivateKeyCipher: string | undefined;
  let appPrivateKeyIv: string | undefined;
  let appPrivateKeyTag: string | undefined;

  const appPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (appPrivateKey && hasMasterKey()) {
    const encrypted = encryptSecret(appPrivateKey);
    appPrivateKeyCipher = encrypted.cipher;
    appPrivateKeyIv = encrypted.iv;
    appPrivateKeyTag = encrypted.tag;
  }

  // Encrypt the OAuth access token
  let accessTokenCipher: string | undefined;
  let accessTokenIv: string | undefined;
  let accessTokenTag: string | undefined;

  if (hasMasterKey()) {
    const encrypted = encryptSecret(tokenData.access_token);
    accessTokenCipher = encrypted.cipher;
    accessTokenIv = encrypted.iv;
    accessTokenTag = encrypted.tag;
  }

  // Upsert the OAuth connection
  await prisma.oAuthConnection.upsert({
    where: {
      userId_provider: { userId: session.user.id, provider: "github" },
    },
    create: {
      userId: session.user.id,
      provider: "github",
      installationId,
      appPrivateKeyCipher,
      appPrivateKeyIv,
      appPrivateKeyTag,
      accessTokenCipher,
      accessTokenIv,
      accessTokenTag,
    },
    update: {
      installationId,
      appPrivateKeyCipher,
      appPrivateKeyIv,
      appPrivateKeyTag,
      accessTokenCipher,
      accessTokenIv,
      accessTokenTag,
    },
  });

  const repos = reposData.repositories.map((r) => ({
    id: r.id,
    fullName: r.full_name,
  }));

  const redirectUrl = new URL("/", process.env.APP_URL || "http://localhost:3300");
  redirectUrl.searchParams.set("github_oauth", "success");
  redirectUrl.searchParams.set("installation_id", installationId);
  redirectUrl.searchParams.set("repos", encodeURIComponent(JSON.stringify(repos)));

  return NextResponse.redirect(redirectUrl);
}
