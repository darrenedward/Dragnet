import { NextResponse } from "next/server";
import { requireSession } from "@/src/lib/api-auth";
import { prisma } from "@/src/lib/prisma";
import {
  isAgreeableSkeptic,
  listProviderStats,
  rejectRate,
  resetProviderStats,
  statsFilePath,
  WARN_MIN_ADJUDICATED,
  WARN_REJECT_RATE,
  type ProviderSkepticStats,
} from "@/src/lib/skepticStats";
import { breakerKeyFor } from "@/src/lib/providerHealth";
import { getFallbackChatPreset, getPrimaryChatPreset } from "@/src/lib/llmPresets";
import fs from "node:fs";

/**
 * Skeptic pass cross-scan stats (issue #73).
 *
 * `GET /api/llm/skeptic-stats`
 *   Returns per-provider outcome counts so the SkepticPanel can render
 *   the current fallback's reject rate + flag agreeable-skeptic models.
 *   Shape:
 *     {
 *       warnRejectRate, warnMinAdjudicated,
 *       fallback: { endpoint, model, key } | null,
 *       repos: Array<{
 *         repoId, repoName, repoPath,
 *         providers: Array<SkepticStatsRow>
 *       }>
 *     }
 *
 * `POST /api/llm/skeptic-stats/reset`
 *   Body: { repoPath?: string, providerKey?: string }
 *   - No body / empty: clears every repo's stats file.
 *   - repoPath only: clears that repo's file entirely.
 *   - repoPath + providerKey: clears that one provider's counts.
 *
 * Auth: session cookie only (matches provider-health). The data is
 * operator-facing, not exposed to API-key consumers.
 */

export interface SkepticStatsRow {
  /** Breaker key: `{provider_host}:{model}`. */
  key: string;
  model: string;
  presetName: string | null;
  confirmed: number;
  downgraded: number;
  rejected: number;
  adjudicated: number;
  rejectRate: number;
  agreeable: boolean;
  updatedAt: number;
}

interface RepoStatsSnapshot {
  repoId: string;
  repoName: string;
  repoPath: string;
  providers: SkepticStatsRow[];
}

interface StatsSnapshot {
  warnRejectRate: number;
  warnMinAdjudicated: number;
  /**
   * Current fallback chat preset, if any. Used by the panel to highlight
   * which row in the table corresponds to "the model running right now".
   * Null when no fallback is set (the pass can't run anyway).
   */
  fallback: { endpoint: string; model: string; key: string; presetName: string } | null;
  repos: RepoStatsSnapshot[];
}

export async function GET(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const repos = await prisma.repository.findMany({
      select: { id: true, name: true, path: true, localPath: true },
    });
    const snapshots: RepoStatsSnapshot[] = [];
    for (const repo of repos) {
      const repoPath = repo.localPath || repo.path;
      const statsPath = statsFilePath(repoPath ?? "", repo.id);
      if (!fs.existsSync(statsPath)) continue;
      const file = listProviderStats(repoPath ?? "", repo.id);
      const providers: SkepticStatsRow[] = Object.entries(file.providers).map(
        ([key, s]) => toRow(key, s),
      );
      if (providers.length === 0) continue;
      snapshots.push({
        repoId: repo.id,
        repoName: repo.name,
        repoPath: repoPath ?? "",
        providers: providers.sort((a, b) => a.key.localeCompare(b.key)),
      });
    }
    const fallbackPreset = getFallbackChatPreset();
    const primaryPreset = getPrimaryChatPreset();
    const fallback =
      fallbackPreset && (!primaryPreset || !samePreset(fallbackPreset, primaryPreset))
        ? {
            endpoint: fallbackPreset.endpoint ?? "",
            model: fallbackPreset.chatModel ?? "",
            key: breakerKeyFor(fallbackPreset.endpoint ?? "", fallbackPreset.chatModel ?? ""),
            presetName: fallbackPreset.name ?? "Fallback",
          }
        : null;
    const body: StatsSnapshot = {
      warnRejectRate: WARN_REJECT_RATE,
      warnMinAdjudicated: WARN_MIN_ADJUDICATED,
      fallback,
      repos: snapshots,
    };
    return NextResponse.json(body);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { repoPath, providerKey } = body as {
      repoPath?: string | null;
      providerKey?: string | null;
    };
    if (!repoPath) {
      const repos = await prisma.repository.findMany({
        select: { id: true, path: true, localPath: true },
      });
      for (const repo of repos) {
        const p = repo.localPath || repo.path;
        resetProviderStats(p ?? null, undefined, repo.id);
      }
      return NextResponse.json({ ok: true, scope: "all-repos" });
    }
    resetProviderStats(repoPath, providerKey ?? undefined);
    return NextResponse.json({
      ok: true,
      scope: providerKey ? "one-key" : "one-repo",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

function toRow(key: string, s: ProviderSkepticStats): SkepticStatsRow {
  // The key is `{host}:{model}`. The model can itself contain a colon
  // (e.g. `provider/model:latest` -> after host strip, the rest is the
  // model id). Split on the FIRST colon only.
  const firstColon = key.indexOf(":");
  const model = firstColon >= 0 ? key.slice(firstColon + 1) : key;
  const adjudicated = s.confirmed + s.downgraded + s.rejected;
  return {
    key,
    model,
    presetName: s.presetName ?? null,
    confirmed: s.confirmed,
    downgraded: s.downgraded,
    rejected: s.rejected,
    adjudicated,
    rejectRate: rejectRate(s),
    agreeable: isAgreeableSkeptic(s),
    updatedAt: s.updatedAt,
  };
}

function samePreset(a: { endpoint?: string; chatModel?: string }, b: { endpoint?: string; chatModel?: string }): boolean {
  return (a.endpoint ?? "") === (b.endpoint ?? "") && (a.chatModel ?? "") === (b.chatModel ?? "");
}
