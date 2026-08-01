/**
 * Tip-ready AFK admit — webhook / poller path.
 *
 * On delivery: prefer the event PR, pin commitHash to provider tip SHA,
 * ensure tip context is ready (fetch head+base when a clone is available;
 * optional review-tree / tip-overlay when those modules are present), then
 * AFK-admit under existing auto-rescan policy.
 *
 * Clone/fetch failure stays fail-closed — no LLM queue work.
 * When no clone is available (API-only poller), tip identity is the updated
 * commit hash; scan prelude guarantees tip tree/overlay before LLM.
 */

import { prisma } from "./prisma";
import { statusForRevision } from "./prRevisionStatus";
import { runGitInRepo, type RepoLike } from "./repoAccess";
import { admitAfkScanJob } from "@/src/services/scanQueue";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export type TipReadyGate = "CLONE_FAILED" | "TIP_CONTEXT_FAILED";

export type TipReadyOk = {
  ok: true;
  prId: string;
  headSha: string;
  mode: "clone" | "hash-only";
  readSource?: string;
};

export type TipReadyFail = {
  ok: false;
  gate: TipReadyGate;
  reason: string;
  prId?: string;
};

export type TipReadyResult = TipReadyOk | TipReadyFail;

export type EventPrHint = {
  githubPrNumber?: number;
  sourceBranch?: string;
  headSha?: string;
  headRef?: string;
  baseRef?: string;
};

/** Put the preferred PR first; leave remaining order stable. */
export function orderPrIdsPreferringEvent(
  prIds: string[],
  preferredPrId: string | null | undefined,
): string[] {
  if (!preferredPrId) return [...prIds];
  if (!prIds.includes(preferredPrId)) return [...prIds];
  return [preferredPrId, ...prIds.filter((id) => id !== preferredPrId)];
}

/** Resolve DB PR id for a webhook/poller event when identifiable. */
export async function findPrIdForEvent(
  repoId: string,
  event: { githubPrNumber?: number; sourceBranch?: string },
): Promise<string | null> {
  if (event.githubPrNumber != null && Number.isFinite(event.githubPrNumber)) {
    const byNumber = await prisma.pullRequest.findFirst({
      where: { repoId, githubPrNumber: event.githubPrNumber },
      select: { id: true },
    });
    if (byNumber) return byNumber.id;
  }
  const branch = event.sourceBranch?.trim();
  if (branch) {
    const byBranch = await prisma.pullRequest.findFirst({
      where: { repoId, sourceBranch: branch },
      select: { id: true },
    });
    if (byBranch) return byBranch.id;
  }
  return null;
}

export type UpdateTipHashResult = {
  previous: string | null;
  updated: boolean;
  headSha: string;
  missing?: boolean;
};

/** Persist provider head SHA on the PR row (tip identity). */
export async function updatePrCommitToProviderTip(
  prId: string,
  headSha: string,
): Promise<UpdateTipHashResult> {
  const tip = (headSha || "").trim();
  if (!tip) {
    return { previous: null, updated: false, headSha: tip };
  }
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId },
    select: { id: true, commitHash: true, status: true },
  });
  if (!pr) {
    return { previous: null, updated: false, headSha: tip, missing: true };
  }
  if (pr.commitHash === tip) {
    return { previous: pr.commitHash, updated: false, headSha: tip };
  }
  await prisma.pullRequest.update({
    where: { id: prId },
    data: {
      commitHash: tip,
      status: statusForRevision(pr.status, pr.commitHash, tip),
    },
  });
  return { previous: pr.commitHash, updated: true, headSha: tip };
}

function hasCloneAccess(repo: RepoLike | null | undefined): boolean {
  if (!repo) return false;
  return Boolean(repo.path || repo.cloneUrl);
}

async function fetchHeadAndBase(
  repo: RepoLike,
  headRef?: string,
  baseRef?: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // Fetch into remote-tracking refs only. Writing refs/heads/* fails when the
  // destination branch is checked out (typical: base = main on the clone).
  // No --prune: limited refspecs must not prune sibling PR branches.
  const refspecs: string[] = [];
  if (headRef?.trim()) {
    const h = headRef.trim();
    refspecs.push(`+refs/heads/${h}:refs/remotes/origin/${h}`);
  }
  if (baseRef?.trim() && baseRef.trim() !== headRef?.trim()) {
    const b = baseRef.trim();
    refspecs.push(`+refs/heads/${b}:refs/remotes/origin/${b}`);
  }
  const args =
    refspecs.length > 0
      ? ["fetch", "origin", ...refspecs]
      : ["fetch", "origin"];
  try {
    const r = await runGitInRepo(repo, args, {
      networkMode: "bridge",
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0) {
      const detail =
        r.stderr?.trim() || r.stdout?.trim() || `git fetch failed (exit ${r.exitCode})`;
      return { ok: false, detail };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function revParseHead(
  repo: RepoLike,
  headSha: string,
  headRef?: string,
): Promise<string | null> {
  const candidates = [headSha];
  if (headRef?.trim()) {
    const h = headRef.trim();
    candidates.push(
      h,
      `refs/remotes/origin/${h}`,
      `origin/${h}`,
      `refs/heads/${h}`,
    );
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      const r = await runGitInRepo(repo, ["rev-parse", "--verify", `${c}^{commit}`], {
        timeoutMs: 15_000,
      });
      if (r.exitCode === 0) {
        const sha = r.stdout.trim();
        if (SHA_RE.test(sha)) return sha;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

type ReviewTreeMod = {
  ensureReviewTree?: (opts: {
    repo: RepoLike;
    headSha: string;
    baseSha?: string;
  }) => Promise<{
    readSource?: string;
    readFile?: (p: string) => Promise<string | null>;
  }>;
  resolveCommitIdentity?: (
    repo: RepoLike,
    pr: { commitHash: string; sourceBranch: string; targetBranch: string },
  ) => Promise<{ headSha: string; baseSha: string }>;
};

type TipOverlayMod = {
  ensureTipOverlay?: (opts: {
    repoId: string;
    headSha: string;
    changedFiles: readonly string[];
    readFile: (p: string) => Promise<string | null>;
  }) => Promise<unknown>;
};

/** Dynamic path so tsc does not require sibling tip-review modules at compile time. */
async function loadOptionalModule<T>(relPath: string): Promise<T | null> {
  try {
    const loaded: unknown = await import(relPath);
    return loaded as T;
  } catch {
    return null;
  }
}

/**
 * Optional tip tree + overlay. Loaded dynamically so this module works
 * before / without tip-review identity PRs; when present, tip-ready
 * materializes context before AFK admit.
 */
async function tryEnsureTipTreeAndOverlay(opts: {
  repo: RepoLike;
  prId: string;
  headSha: string;
  baseRef?: string;
  sourceBranch?: string;
  targetBranch?: string;
}): Promise<{ readSource?: string; error?: string }> {
  try {
    const treeMod = await loadOptionalModule<ReviewTreeMod>("./reviewTree");
    if (!treeMod?.ensureReviewTree) return {};

    const pr = {
      commitHash: opts.headSha,
      sourceBranch: opts.sourceBranch || "",
      targetBranch: opts.targetBranch || opts.baseRef || "",
    };
    let headSha = opts.headSha;
    let baseSha = "";
    if (treeMod.resolveCommitIdentity) {
      const id = await treeMod.resolveCommitIdentity(opts.repo, pr);
      headSha = id.headSha || headSha;
      baseSha = id.baseSha || "";
    }
    const tree = await treeMod.ensureReviewTree({
      repo: opts.repo,
      headSha,
      baseSha: baseSha || undefined,
    });
    const overlayMod = await loadOptionalModule<TipOverlayMod>("./tipOverlay");
    if (overlayMod?.ensureTipOverlay && tree?.readFile) {
      const readFile = tree.readFile.bind(tree);
      await overlayMod.ensureTipOverlay({
        repoId: opts.repo.id,
        headSha,
        changedFiles: [],
        readFile,
      });
    }
    return { readSource: tree?.readSource };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pin tip identity and ensure tip context before AFK admit.
 *
 * - With clone: fetch head/base, update hash, verify object, optional tree/overlay.
 * - Without clone (poller API-only): update hash only; scan prelude does the rest.
 */
export async function ensureTipReady(opts: {
  repo: RepoLike;
  prId: string;
  providerHeadSha?: string;
  headRef?: string;
  baseRef?: string;
  /** When true (default if clone available), fetch failure blocks tip-ready. */
  requireClone?: boolean;
}): Promise<TipReadyResult> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: opts.prId },
    select: {
      id: true,
      commitHash: true,
      status: true,
      sourceBranch: true,
      targetBranch: true,
      repoId: true,
    },
  });
  if (!pr) {
    return {
      ok: false,
      gate: "TIP_CONTEXT_FAILED",
      reason: `PR ${opts.prId} not found`,
      prId: opts.prId,
    };
  }

  const providerTip = (opts.providerHeadSha || "").trim();
  const headSha = providerTip || pr.commitHash;
  if (!headSha) {
    return {
      ok: false,
      gate: "TIP_CONTEXT_FAILED",
      reason: "No provider tip or stored commit hash",
      prId: opts.prId,
    };
  }

  const cloneOk = hasCloneAccess(opts.repo);
  const requireClone = opts.requireClone ?? cloneOk;

  if (!cloneOk) {
    if (requireClone) {
      return {
        ok: false,
        gate: "CLONE_FAILED",
        reason: "No clone path or cloneUrl for tip fetch",
        prId: opts.prId,
      };
    }
    // Hash-only: poller / no local tree. Scan prelude materializes tip context.
    if (providerTip) {
      await updatePrCommitToProviderTip(opts.prId, providerTip);
    }
    return { ok: true, prId: opts.prId, headSha, mode: "hash-only" };
  }

  const headRef = opts.headRef || pr.sourceBranch;
  const baseRef = opts.baseRef || pr.targetBranch;
  const fetched = await fetchHeadAndBase(opts.repo, headRef, baseRef);
  if (fetched.ok === false) {
    return {
      ok: false,
      gate: "CLONE_FAILED",
      reason: fetched.detail,
      prId: opts.prId,
    };
  }

  // Pin tip identity only after fetch succeeds (AC: update hash after fetch).
  if (providerTip) {
    await updatePrCommitToProviderTip(opts.prId, providerTip);
  }

  const resolved = await revParseHead(opts.repo, headSha, headRef);
  // Prefer verified object; still accept provider tip after successful fetch
  // (shallow clones may not resolve until deepen — scan prelude handles that).
  const pinned = resolved || (SHA_RE.test(headSha) ? headSha : null);
  if (!pinned) {
    return {
      ok: false,
      gate: "TIP_CONTEXT_FAILED",
      reason: `Could not resolve tip ${headSha.slice(0, 12)} after fetch`,
      prId: opts.prId,
    };
  }

  if (pinned !== headSha) {
    await updatePrCommitToProviderTip(opts.prId, pinned);
  }

  const treeResult = await tryEnsureTipTreeAndOverlay({
    repo: opts.repo,
    prId: opts.prId,
    headSha: pinned,
    baseRef,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
  });
  if (treeResult.error) {
    // Tree/overlay is best-effort before admit when modules exist; identity
    // + fetch already succeeded. Log and continue — scan prelude re-ensures.
    console.warn(
      `[tip-ready] tree/overlay soft-fail for ${opts.prId}: ${treeResult.error}`,
    );
  }

  return {
    ok: true,
    prId: opts.prId,
    headSha: pinned,
    mode: "clone",
    readSource: treeResult.readSource,
  };
}

export type AdmitAfkAfterTipReadyResult = {
  admitted: number;
  preferredPrId?: string | null;
  error?: string;
  tipReadyFailed?: string[];
};

/**
 * Tip-ready then AFK-admit. Clone failure → zero admits (fail-closed).
 * Event PR is ordered first when identifiable.
 */
export async function admitAfkAfterTipReady(opts: {
  repoId: string;
  prIds: string[];
  triggerReason: string;
  repo?: RepoLike | null;
  event?: EventPrHint;
  /** Per-PR provider tips (poller observed SHAs). */
  providerTips?: Record<string, string>;
  cloneFailed?: boolean;
  cloneError?: string;
}): Promise<AdmitAfkAfterTipReadyResult> {
  if (opts.cloneFailed) {
    return {
      admitted: 0,
      error: opts.cloneError || "clone failed",
    };
  }

  let preferredPrId: string | null = null;
  if (opts.event) {
    preferredPrId = await findPrIdForEvent(opts.repoId, opts.event);
  }

  // Ensure preferred PR is in the admit set even if scanRepoPrs missed it.
  let prIds = [...opts.prIds];
  if (preferredPrId && !prIds.includes(preferredPrId)) {
    prIds = [preferredPrId, ...prIds];
  }
  prIds = orderPrIdsPreferringEvent(prIds, preferredPrId);

  const tipReadyFailed: string[] = [];
  let admitted = 0;
  const errors: string[] = [];
  const repo: RepoLike = opts.repo ?? { id: opts.repoId };
  const cloneAvailable = hasCloneAccess(opts.repo);

  // One head/base fetch per delivery when clone is available (event refs preferred).
  let sharedFetchOk = !cloneAvailable;
  if (cloneAvailable && prIds.length > 0) {
    const fetched = await fetchHeadAndBase(
      repo,
      opts.event?.headRef,
      opts.event?.baseRef,
    );
    if (fetched.ok === false) {
      return {
        admitted: 0,
        preferredPrId,
        error: `tip-ready-failed: CLONE_FAILED ${fetched.detail}`,
        tipReadyFailed: [`*: CLONE_FAILED ${fetched.detail}`],
      };
    }
    sharedFetchOk = true;
  }

  for (const prId of prIds) {
    const isPreferred = prId === preferredPrId;
    const providerHeadSha =
      (isPreferred ? opts.event?.headSha : undefined) ||
      opts.providerTips?.[prId];

    // Shared fetch already ran; per-PR tip-ready only pins hash + verifies object.
    // Pass requireClone false when clone missing; when clone present and fetch ok,
    // still call ensureTipReady which will re-fetch (cheap no-op-ish) OR we pin hash only.
    let tip: TipReadyResult;
    if (!sharedFetchOk) {
      tip = {
        ok: false,
        gate: "CLONE_FAILED",
        reason: "shared tip fetch failed",
        prId,
      };
    } else if (!cloneAvailable) {
      tip = await ensureTipReady({
        repo,
        prId,
        providerHeadSha,
        requireClone: false,
      });
    } else {
      // Clone path: pin hash from provider / stored, verify object (fetch already done).
      const pr = await prisma.pullRequest.findUnique({
        where: { id: prId },
        select: {
          id: true,
          commitHash: true,
          status: true,
          sourceBranch: true,
          targetBranch: true,
        },
      });
      if (!pr) {
        tip = {
          ok: false,
          gate: "TIP_CONTEXT_FAILED",
          reason: `PR ${prId} not found`,
          prId,
        };
      } else {
        const headSha = (providerHeadSha || pr.commitHash || "").trim();
        if (!headSha) {
          tip = {
            ok: false,
            gate: "TIP_CONTEXT_FAILED",
            reason: "No provider tip or stored commit hash",
            prId,
          };
        } else {
          if (providerHeadSha) {
            await updatePrCommitToProviderTip(prId, providerHeadSha);
          }
          const headRef = (isPreferred ? opts.event?.headRef : undefined) || pr.sourceBranch;
          const resolved = await revParseHead(repo, headSha, headRef);
          const pinned = resolved || (SHA_RE.test(headSha) ? headSha : null);
          if (!pinned) {
            tip = {
              ok: false,
              gate: "TIP_CONTEXT_FAILED",
              reason: `Could not resolve tip ${headSha.slice(0, 12)} after fetch`,
              prId,
            };
          } else {
            if (pinned !== headSha) {
              await updatePrCommitToProviderTip(prId, pinned);
            }
            const treeResult = await tryEnsureTipTreeAndOverlay({
              repo,
              prId,
              headSha: pinned,
              baseRef: (isPreferred ? opts.event?.baseRef : undefined) || pr.targetBranch,
              sourceBranch: pr.sourceBranch,
              targetBranch: pr.targetBranch,
            });
            if (treeResult.error) {
              console.warn(
                `[tip-ready] tree/overlay soft-fail for ${prId}: ${treeResult.error}`,
              );
            }
            tip = {
              ok: true,
              prId,
              headSha: pinned,
              mode: "clone",
              readSource: treeResult.readSource,
            };
          }
        }
      }
    }

    if (tip.ok === false) {
      tipReadyFailed.push(`${prId}: ${tip.gate} ${tip.reason}`);
      console.warn(`[tip-ready] skip AFK admit for ${prId}: ${tip.gate} ${tip.reason}`);
      continue;
    }

    try {
      const job = await admitAfkScanJob({
        prId,
        repoId: opts.repoId,
        commitHash: tip.headSha,
        triggerReason: opts.triggerReason,
      });
      if (job) admitted += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tip-ready] AFK admit failed for ${prId}:`, err);
      errors.push(`${prId}: ${msg}`);
    }
  }

  const errorParts = [
    ...(errors.length > 0 ? errors : []),
    ...(tipReadyFailed.length > 0 && admitted === 0
      ? [`tip-ready-failed: ${tipReadyFailed.join("; ")}`]
      : []),
  ];

  return {
    admitted,
    preferredPrId,
    error: errorParts.length > 0 ? errorParts.join("; ") : undefined,
    tipReadyFailed: tipReadyFailed.length > 0 ? tipReadyFailed : undefined,
  };
}
