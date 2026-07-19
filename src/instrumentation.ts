/**
 * Next.js instrumentation hook — runs `register()` once on server boot,
 * before any request is served. Next.js 16 auto-discovers this file at
 * `src/instrumentation.ts`.
 *
 * Responsibilities:
 *   1. Sweep orphaned `ReviewRun` rows (status=in_progress past the stale
 *      TTL) so a freshly restarted server doesn't present bricked PRs.
 *      See `src/services/runReaper.ts` for the why.
 *   2. Start the PR polling worker for repos with `isPollingEnabled = true`.
 *      This allows Dragnet to detect new PR commits in firewalled/local
 *      environments where GitHub cannot send webhooks directly.
 *
 * All errors are swallowed — boot must not fail because a DB or Docker
 * operation didn't succeed on startup.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Dynamic import keeps this code out of the edge bundle and avoids
  // loading Prisma during module evaluation of instrumentation.ts
  // (which would break `next build` on empty env).
  const { reapStaleRuns } = await import("./services/runReaper");
  void reapStaleRuns();

  // The queue worker is always enabled in the Node runtime. It claims jobs
  // with a durable lease and invokes the scan route through its internal
  // worker-authenticated path, so queued work survives request completion and
  // a server restart.
  if (process.env.DRAGNET_MASTER_KEY) {
    try {
      const { startScanQueueWorker } = await import("./services/scanQueue");
      const baseUrl = (process.env.DRAGNET_URL || process.env.DRAGNET_PUBLIC_URL || "http://localhost:3300").replace(/\/$/, "");
      const workerKey = process.env.DRAGNET_MASTER_KEY;
      startScanQueueWorker({
        execute: async (job) => {
          const query = new URLSearchParams({
            queuedCommit: job.commitHash,
            triggerReason: job.triggerReason,
            ...(job.triggerReason.startsWith("retry-failed-chunks:")
              ? { retryRunId: job.triggerReason.slice("retry-failed-chunks:".length) }
              : {}),
            ...(job.forced ? { force: "true" } : {}),
            ...(job.resumeRequested ? { resume: "true" } : {}),
            ...(job.freshRequested ? { fresh: "true" } : {}),
          });
          const res = await fetch(`${baseUrl}/api/prs/${encodeURIComponent(job.prId)}/scan?${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-dragnet-queue-worker": workerKey },
            body: "{}",
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `scan route returned ${res.status}`);
          return {
            state: body.interrupted ? "interrupted" : "completed",
            reviewRunId: typeof body.runId === "string" ? body.runId : null,
          };
        },
      });
    } catch (err: any) {
      console.warn("[instrumentation] scan queue worker failed to start:", err.message);
    }
  }

  // Seed LLM presets from legacy file if DB is empty, then preload cache.
  const { seedFromLegacyFile, preloadCache } = await import("./lib/llmPresets");
  void seedFromLegacyFile().then(() => preloadCache());

  // Start the local-repo polling worker (prPollingWorker) only when enabled
  // via environment variable. Keeping this opt-in avoids unnecessary GitHub
  // API calls for deployments that rely exclusively on webhooks.
  if (process.env.DRAGNET_POLLING_ENABLED === "1") {
    try {
      const { startPolling } = await import("./lib/prPollingWorker");
      const { admitPollingScan } = await import("./lib/pollingScanAdmission");
      startPolling(async (repoId, prId, commitHash) => {
        await admitPollingScan({ repoId, prId, commitHash });
      });
    } catch (err: any) {
      console.warn("[instrumentation] polling worker failed to start:", err.message);
    }
  }

  // Start the hosted-mode outbound poller (discovers PRs from GitHub/GitLab
  // API for hosted-mode repos and auto-triggers scans). Uses its own env var
  // and interval so it's independent from the local-repo polling worker.
  if (process.env.DRAGNET_HOSTED_POLLING_ENABLED === "1") {
    try {
      const { startHostedPoller } = await import("./services/hostedScan/poller");
      startHostedPoller();
    } catch (err: any) {
      console.warn("[instrumentation] hosted poller failed to start:", err.message);
    }
  }
}
