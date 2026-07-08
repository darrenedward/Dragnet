/**
 * Stack-topology helper for `/dragnet merge` and the prlist response.
 *
 * A "stack" is a chain of PRs where each PR's `targetBranch` is the
 * `sourceBranch` of the PR below it. Example:
 *
 *   PR1: feat/a → main
 *   PR2: feat/b → feat/a
 *   PR3: feat/c → feat/b
 *
 * For PR3, dependencies (PRs that must merge first) = [PR2, PR1].
 * For PR1, dependencies = [] (standalone).
 *
 * Used by:
 * - `src/app/api/command/[[...args]]/route.ts` `prlist` handlers — attach
 *   topology fields to each PR in the response
 * - `.claude/skills/dragnet/references/merge.md` — consume the fields to
 *   walk the stack client-side and detect unscanned dependencies
 *
 * Identity note: Dragnet's DB does not store GitHub PR numbers — only
 * `sourceBranch`/`targetBranch`. The skill cross-references with
 * `gh pr list --json number,headRefName` to recover real PR numbers for
 * display. Topology responses key off `sourceBranch`, which is stable
 * across the stack walk.
 *
 * **Staleness caveat:** Dragnet's `targetBranch` is set to `baseBranch`
 * at PR creation and never re-synced from GitHub (see
 * `getRealPrs.ts:175`). Retargeted PRs (common in stacked-PR
 * workflows) will show stale topology here. Callers that need
 * authoritative topology MUST re-walk via `gh pr list --json
 * baseRefName,headRefName`. The fields below are advisory/hint.
 *
 * The walk is O(N) per PR after the index is built; total O(N²) worst
 * case but typical repos have <30 open PRs so it's negligible. Cycle
 * guard prevents infinite loops on theoretical branch-loop edge cases
 * (shouldn't happen in GitHub flow, but defensive).
 */

export interface PrTopologyInput {
  id: string;
  sourceBranch: string;
  targetBranch: string;
  rating: number | null;
}

export interface PrDependency {
  prId: string;
  sourceBranch: string;
  targetBranch: string;
  scanned: boolean;
  rating: number | null;
}

export interface PrTopology {
  /** Count of PRs below this one in the stack (0 = standalone). */
  stackDepth: number;
  /** PRs that must merge first, root-first order (deepest dependency first). */
  dependencies: PrDependency[];
  /** Dependencies that have no completed ReviewRun. */
  unscannedDepsCount: number;
}

/**
 * Compute topology for every PR in the input list.
 *
 * @param prs All open PRs in the repo (any status — caller decides filtering)
 * @param scannedPrIds Set of prIds with at least one completed ReviewRun
 * @returns Map keyed by prId
 */
export function computeStackTopology(
  prs: PrTopologyInput[],
  scannedPrIds: Set<string>,
): Map<string, PrTopology> {
  // Index: sourceBranch → PR. If two PRs share a source branch (rare —
  // usually means one was opened from another's head), keep the first
  // encountered for determinism.
  const sourceIndex = new Map<string, PrTopologyInput>();
  for (const pr of prs) {
    if (!sourceIndex.has(pr.sourceBranch)) {
      sourceIndex.set(pr.sourceBranch, pr);
    }
  }

  const result = new Map<string, PrTopology>();

  for (const pr of prs) {
    const dependencies: PrDependency[] = [];
    const visited = new Set<string>([pr.id]);
    let cursor: string | undefined = pr.targetBranch;
    let safety = prs.length + 1; // hard ceiling — can't chain longer than N+1

    while (cursor && safety-- > 0) {
      const dep = sourceIndex.get(cursor);
      if (!dep) break; // target is main or has no PR landing into it
      if (visited.has(dep.id)) {
        console.warn(
          `[prStackTopology] cycle detected at PR ${dep.sourceBranch} while walking from ${pr.sourceBranch} — breaking`,
        );
        break;
      }
      visited.add(dep.id);
      dependencies.push({
        prId: dep.id,
        sourceBranch: dep.sourceBranch,
        targetBranch: dep.targetBranch,
        scanned: scannedPrIds.has(dep.id),
        rating: dep.rating,
      });
      cursor = dep.targetBranch;
    }

    // Reverse: walk produces closest-first but the contract is
    // root-first (deepest dep first), per merge.md "stack-root-first order".
    dependencies.reverse();

    result.set(pr.id, {
      stackDepth: dependencies.length,
      dependencies,
      unscannedDepsCount: dependencies.filter((d) => !d.scanned).length,
    });
  }

  return result;
}
