import { NextResponse } from "next/server";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function GET(request: Request) {
  const auth = await authenticateSessionOrKey(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  return NextResponse.json({
    githubWebhookUrl: `${baseUrl}/api/webhooks/github`,
    gitlabWebhookUrl: `${baseUrl}/api/webhooks/gitlab`,
    scanApiUrl: `${baseUrl}/api/hosted-scan/scan`,
    documentation: {
      github: "Configure a GitHub webhook: Settings → Webhooks → Add webhook. Payload URL: the githubWebhookUrl above. Content type: application/json. Secret: your repo's webhookSecret. Events: Pull requests, Pushes.",
      gitlab: "Configure a GitLab webhook: Settings → Webhooks → Add webhook. URL: the gitlabWebhookUrl above. Secret token: your repo's webhookSecret. Trigger: Merge request events, Push events.",
      scanApi: "POST to scanApiUrl with Authorization: Bearer hs_<scan_token> and JSON body: { prNumber, title, headBranch, baseBranch, commitHash, author?, description? }",
    },
  });
}
