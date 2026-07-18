import { NextResponse } from "next/server";
import { verifyGitlabToken, findRepoByCloneUrl, gitFetch, scanRepoPrs, getOpenPrIds } from "../../../../lib/webhook";
import { enqueue } from "@/src/services/remoteFetchWorker";
import { checkDelivery } from "../../../../lib/webhookReplay";
import { admitScanJobForPr } from "@/src/services/scanQueue";
import { triggerHostedScan } from "@/src/services/hostedScan/orchestrator";
import { createDeliveryLog, updateDeliveryStatus } from "../../../../lib/webhookDelivery";
import type { HostedPrData } from "@/src/services/hostedScan/orchestrator";
import { isAutoRescanEnabled } from "@/src/lib/autoRescanPolicy";

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

  const triggerAfkScans = async (prIds: string[]) => {
    if (!isAutoRescanEnabled(matched.autoRescanPolicy)) return 0;
    let admitted = 0;
    for (const prId of prIds) {
      try {
        if (await admitScanJobForPr({ prId, triggerReason: "webhook" })) admitted++;
      } catch (err) {
        console.error(`[webhook] AFK scan failed for ${prId}:`, err);
      }
    }
    return admitted;
  };

  const logDelivery = deliveryGuid
    ? await createDeliveryLog({
        repoId: matched.id,
        provider: "gitlab",
        eventType: event,
        deliveryGuid,
        hostedMode: matched.hostedMode,
      })
    : null;

  if (event === "Merge Request Hook") {
    const mr = payload.object_attributes;
    if (!mr) {
      if (logDelivery) await updateDeliveryStatus(logDelivery, "failed", "Missing merge request");
      return NextResponse.json({ error: "Missing merge request" }, { status: 400 });
    }

    if (matched.hostedMode) {
      if (!mr.source_branch || !mr.target_branch || !mr.last_commit?.id) {
        if (logDelivery) await updateDeliveryStatus(logDelivery, "failed", "Missing merge request data");
        return NextResponse.json({ error: "Missing merge request data (source_branch, target_branch, last_commit.id)" }, { status: 400 });
      }
      const prData: HostedPrData = {
        prNumber: mr.iid,
        title: mr.title || "Untitled",
        headBranch: mr.source_branch,
        baseBranch: mr.target_branch,
        commitHash: mr.last_commit.id,
        author: payload.user?.name || "webhook",
        description: mr.description || undefined,
      };
      const result = await triggerHostedScan(matched.id, prData, { automatic: true });
      if (!result.ok) {
        if (logDelivery) await updateDeliveryStatus(logDelivery, "failed", (result as { error: string }).error);
        return NextResponse.json({ error: (result as { error: string }).error }, { status: 400 });
      }
      if (logDelivery) await updateDeliveryStatus(logDelivery, "completed");
      return NextResponse.json({ ok: true, repo: matched.id, mr: mr.iid, hosted: true, prId: result.prId });
    }

    const prIds: string[] = [];
    if (matched.path || matched.cloneUrl) {
      await gitFetch(matched);
      const ids = await scanRepoPrs(matched);
      prIds.push(...ids);
    } else {
      const localPath = await enqueue(matched.id).catch((err) => {
        console.error(`[webhook] enqueue failed for ${matched.id}:`, err);
        return null;
      });
      if (localPath) {
        await gitFetch({ ...matched, path: localPath });
        const ids = await scanRepoPrs({ ...matched, path: localPath });
        prIds.push(...ids);
      }
    }
    const afkScans = await triggerAfkScans(prIds);
    if (logDelivery) await updateDeliveryStatus(logDelivery, "completed");
    return NextResponse.json({ ok: true, repo: matched.id, mr: mr.iid, afkScans });
  }

  if (event === "Push Hook") {
    if (matched.hostedMode) {
      const prIds = await getOpenPrIds(matched.id);
      const afkScans = await triggerAfkScans(prIds);
      if (logDelivery) await updateDeliveryStatus(logDelivery, afkScans > 0 ? "completed" : "ignored");
      return NextResponse.json({ ok: true, repo: matched.id, hosted: true, afkScans });
    }

    const prIds: string[] = [];
    if (matched.path || matched.cloneUrl) {
      await gitFetch(matched);
      const ids = await scanRepoPrs(matched);
      prIds.push(...ids);
    } else {
      const localPath = await enqueue(matched.id).catch((err) => {
        console.error(`[webhook] enqueue failed for ${matched.id}:`, err);
        return null;
      });
      if (localPath) {
        await gitFetch({ ...matched, path: localPath });
        const ids = await scanRepoPrs({ ...matched, path: localPath });
        prIds.push(...ids);
      }
    }
    const afkScans = await triggerAfkScans(prIds);
    if (logDelivery) await updateDeliveryStatus(logDelivery, "completed");
    return NextResponse.json({ ok: true, repo: matched.id, afkScans });
  }

  if (logDelivery) await updateDeliveryStatus(logDelivery, "ignored");
  return NextResponse.json({ ok: true, ignored: true, event });
}
