import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireSession } from "@/src/lib/api-auth";
import { getInstallationToken } from "@/src/lib/githubApp";

interface GitHubRepo {
  id: number;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string | null;
  clone_url: string;
}

/**
 * GET /api/github/repos
 *
 * Lists all repositories accessible through the user's GitHub App installation.
 * Requires an active GitHub OAuth connection with a valid installation ID.
 *
 * Returns:
 *   - 401 if not authenticated
 *   - 404 if no GitHub connection exists
 *   - 500 if GitHub App is not configured or token fetch fails
 *   - 200 with list of repos on success
 */
export async function GET(req: Request) {
  // Require authenticated session
  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Look up the user's GitHub OAuth connection
  const connection = await prisma.oAuthConnection.findUnique({
    where: {
      userId_provider: { userId: session.user.id, provider: "github" },
    },
    select: { installationId: true },
  });

  if (!connection) {
    return NextResponse.json(
      { error: "No GitHub connection found. Please connect GitHub first." },
      { status: 404 },
    );
  }

  if (!connection.installationId) {
    return NextResponse.json(
      { error: "GitHub connection has no installation ID." },
      { status: 500 },
    );
  }

  // Get a fresh installation access token
  let token: string;
  try {
    token = await getInstallationToken(connection.installationId);
  } catch (err: any) {
    console.error("[github/repos] Failed to get installation token:", err.message);
    return NextResponse.json(
      { error: "Failed to authenticate with GitHub. Please reconnect GitHub." },
      { status: 500 },
    );
  }

  // Fetch repositories from the installation
  const res = await fetch(
    "https://api.github.com/installation/repositories",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[github/repos] GitHub API error:", res.status, body);
    return NextResponse.json(
      { error: `GitHub API error: ${res.status} ${res.statusText}` },
      { status: 500 },
    );
  }

  const data = (await res.json()) as {
    repositories: GitHubRepo[];
  };

  const repos = data.repositories.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    private: repo.private,
    description: repo.description,
    defaultBranch: repo.default_branch ?? "main",
    cloneUrl: repo.clone_url,
  }));

  return NextResponse.json({ repos });
}
