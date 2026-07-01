import { NextResponse } from "next/server";
import { requireSession } from "@/src/lib/api-auth";
import { prisma } from "@/src/lib/prisma";
import {
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  decideState,
  getBreakerCooldownMs,
  getBreakerThreshold,
  healthFilePath,
  readHealthFile,
  resetProviderHealth,
  type CircuitState,
  type Health,
} from "@/src/lib/providerHealth";
import fs from "node:fs";

/**
 * Phase 3 provider circuit breaker — LLM Settings surface.
 *
 * `GET /api/llm/provider-health`
 *   Returns the breaker snapshot for every repo with a health file.
 *   Shape:
 *     {
 *       threshold: number,
 *       cooldownMs: number,
 *       repos: Array<{
 *         repoId, repoName, repoPath,
 *         providers: Array<ProviderHealthRow>
 *       }>
 *     }
 *
 * `POST /api/llm/provider-health/reset`
 *   Body: { repoPath?: string, endpoint?: string, model?: string }
 *   - No body / empty: clears every repo's health file.
 *   - repoPath only: clears that repo's file entirely.
 *   - repoPath + endpoint + model: clears that one key.
 *
 * The LLM Settings page is global (per-server), but breaker state lives
 * per-repo under `<repo.path>/.dragnet/`. We iterate all repos so the
 * operator sees the full picture. Most installs have one repo.
 */

export interface ProviderHealthRow {
  /** Breaker key: `{provider_host}:{model}`. */
  key: string;
  model: string;
  presetName: string | null;
  state: CircuitState;
  consecutiveQualityFailures: number;
  openedAt: number | null;
  cooldownEndsAt: number | null;
  updatedAt: number;
}

interface RepoHealthSnapshot {
  repoId: string;
  repoName: string;
  repoPath: string;
  providers: ProviderHealthRow[];
}

interface HealthSnapshot {
  threshold: number;
  cooldownMs: number;
  defaultThreshold: number;
  defaultCooldownMs: number;
  repos: RepoHealthSnapshot[];
  /** Epoch ms — clients use this to compute remaining cooldown client-side. */
  serverNowMs: number;
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
    const now = Date.now();
    const snapshots: RepoHealthSnapshot[] = [];
    for (const repo of repos) {
      const repoPath = repo.localPath || repo.path;
      if (!repoPath) continue;
      // Skip repos with no health file yet — fresh repos have no state.
      if (!fs.existsSync(healthFilePath(repoPath))) continue;
      const file = readHealthFile(repoPath);
      const providers: ProviderHealthRow[] = Object.entries(file.providers).map(
        ([key, h]) => toRow(key, h, now),
      );
      // Only include repos that currently have at least one record.
      // Avoids cluttering the UI with empty entries.
      if (providers.length === 0) continue;
      snapshots.push({
        repoId: repo.id,
        repoName: repo.name,
        repoPath,
        providers: providers.sort((a, b) => a.key.localeCompare(b.key)),
      });
    }
    const body: HealthSnapshot = {
      threshold: getBreakerThreshold(),
      cooldownMs: getBreakerCooldownMs(),
      defaultThreshold: DEFAULT_BREAKER_THRESHOLD,
      defaultCooldownMs: DEFAULT_BREAKER_COOLDOWN_MS,
      repos: snapshots,
      serverNowMs: now,
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
    const { repoPath, endpoint, model } = body as {
      repoPath?: string | null;
      endpoint?: string | null;
      model?: string | null;
    };

    if (!repoPath) {
      // Reset every repo's health file. Iterate known repos from DB so
      // we don't blindly scan the filesystem.
      const repos = await prisma.repository.findMany({
        select: { path: true, localPath: true },
      });
      for (const repo of repos) {
        const p = repo.localPath || repo.path;
        if (p) resetProviderHealth(p);
      }
      return NextResponse.json({ ok: true, scope: "all-repos" });
    }

    resetProviderHealth(repoPath, endpoint ?? undefined, model ?? undefined);
    return NextResponse.json({
      ok: true,
      scope: endpoint && model ? "one-key" : "one-repo",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

function toRow(key: string, h: Health, now: number): ProviderHealthRow {
  const [_host, ...modelParts] = key.split(":");
  const model = modelParts.join(":") || "";
  return {
    key,
    model,
    presetName: h.presetName ?? null,
    state: decideState(h, now),
    consecutiveQualityFailures: h.consecutiveQualityFailures,
    openedAt: h.openedAt,
    cooldownEndsAt: h.cooldownEndsAt,
    updatedAt: h.updatedAt,
  };
}
