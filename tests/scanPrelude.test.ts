import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runScanPrelude,
  diffUnavailableResult,
  cloneReadyResult,
  preludeFailToJson,
  blocksExplicitAdmit,
  parseScanGate,
  blockedAtLabel,
  type ScanPreludeDeps,
} from "../src/lib/scanPrelude";

describe("runScanPrelude", () => {
  const repo = {
    id: "repo-1",
    name: "demo",
    indexedAt: "2026-01-01T00:00:00Z",
    lastCommitHash: "abc1234",
    path: null as string | null,
    cloneUrl: "https://github.com/o/r.git",
  };

  let deps: ScanPreludeDeps;

  beforeEach(() => {
    deps = {
      getConfigurationIssues: () => [],
      assertIndexFresh: vi.fn().mockResolvedValue({ ok: true }),
      isIndexing: () => false,
      indexFolder: vi.fn().mockResolvedValue(undefined),
      reindexRemote: vi.fn().mockResolvedValue("/workspace"),
    };
  });

  it("passes when config and index are fresh", async () => {
    const r = await runScanPrelude(repo, deps);
    expect(r).toEqual({ ok: true, reindexed: false });
  });

  it("blocks remote repos with status error as CLONE_FAILED", async () => {
    const r = await runScanPrelude(
      {
        ...repo,
        status: "error",
        lastFetchError: "Git sync failed (exit 128)",
        provider: "github",
      },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("CLONE_FAILED");
      expect(r.message).toContain("Git sync failed");
      expect(r.httpStatus).toBe(503);
    }
    expect(deps.assertIndexFresh).not.toHaveBeenCalled();
  });

  it("blocks remote repos still cloning as CLONE_FAILED", async () => {
    const r = await runScanPrelude(
      { ...repo, status: "cloning", provider: "github" },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("CLONE_FAILED");
      expect(r.message).toMatch(/still in progress/i);
    }
  });

  it("does not clone-gate local repos", async () => {
    const r = await runScanPrelude(
      { ...repo, cloneUrl: null, path: "/local", status: "error", provider: "local" },
      deps,
    );
    expect(r).toEqual({ ok: true, reindexed: false });
  });

  it("blocks on CONFIG_REQUIRED before index work", async () => {
    deps.getConfigurationIssues = () => [
      { role: "chat", label: "Chat", provider: null, reason: "missing_provider" },
    ];
    const r = await runScanPrelude(repo, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("CONFIG_REQUIRED");
      expect(r.httpStatus).toBe(400);
      expect(r.message).toBeTruthy();
    }
    expect(deps.assertIndexFresh).not.toHaveBeenCalled();
  });

  it("hard-blocks INDEX_REQUIRED", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "INDEX_REQUIRED",
      message: "not indexed",
    });
    const r = await runScanPrelude(repo, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("INDEX_REQUIRED");
      expect(r.message).toBe("not indexed");
      expect(r.httpStatus).toBe(409);
    }
    expect(deps.reindexRemote).not.toHaveBeenCalled();
    expect(deps.indexFolder).not.toHaveBeenCalled();
  });

  it("returns INDEXING_IN_PROGRESS when index is already running", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "INDEX_REQUIRED",
      message: "not indexed",
    });
    deps.isIndexing = () => true;
    const r = await runScanPrelude(repo, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.gate).toBe("INDEXING_IN_PROGRESS");
  });

  it("STALE with volume-only repo triggers reindexRemote", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "STALE_INDEX",
      message: "stale",
    });
    const r = await runScanPrelude({ ...repo, path: null, cloneUrl: "git@x:y/z.git" }, deps);
    expect(r).toEqual({ ok: true, reindexed: true });
    expect(deps.reindexRemote).toHaveBeenCalledWith("repo-1");
    expect(deps.indexFolder).not.toHaveBeenCalled();
  });

  it("STALE with local path uses indexFolder", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "STALE_INDEX",
      message: "stale",
    });
    const r = await runScanPrelude({ ...repo, path: "/host/repo", cloneUrl: null }, deps);
    expect(r).toEqual({ ok: true, reindexed: true });
    expect(deps.indexFolder).toHaveBeenCalledWith("repo-1", "/host/repo");
  });

  it("STALE local path with index already running fails closed as INDEXING_IN_PROGRESS", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "STALE_INDEX",
      message: "stale",
    });
    deps.isIndexing = () => true;
    const r = await runScanPrelude({ ...repo, path: "/host/repo", cloneUrl: null }, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("INDEXING_IN_PROGRESS");
      expect(r.httpStatus).toBe(409);
    }
    expect(deps.indexFolder).not.toHaveBeenCalled();
  });

  it("STALE local race throw maps to INDEXING_IN_PROGRESS not REINDEX_FAILED", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "STALE_INDEX",
      message: "stale",
    });
    deps.indexFolder = vi
      .fn()
      .mockRejectedValue(new Error("Index already in progress for this repo — wait for the current run to finish."));
    const r = await runScanPrelude({ ...repo, path: "/host/repo", cloneUrl: null }, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("INDEXING_IN_PROGRESS");
      expect(r.httpStatus).toBe(409);
    }
  });

  it("reindex failure blocks with REINDEX_FAILED", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "STALE_INDEX",
      message: "stale",
    });
    deps.reindexRemote = vi.fn().mockRejectedValue(new Error("volume gone"));
    const r = await runScanPrelude(repo, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("REINDEX_FAILED");
      expect(r.message).toContain("volume gone");
    }
  });

  it("STALE with neither path nor cloneUrl fails closed", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "STALE_INDEX",
      message: "stale",
    });
    const r = await runScanPrelude({ ...repo, path: null, cloneUrl: null }, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.gate).toBe("REINDEX_FAILED");
  });

  it("STALE remote reindex already in flight fails closed (null enqueue)", async () => {
    deps.assertIndexFresh = vi.fn().mockResolvedValue({
      ok: false,
      kind: "STALE_INDEX",
      message: "stale",
    });
    deps.reindexRemote = vi.fn().mockResolvedValue(null);
    const r = await runScanPrelude(repo, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("INDEXING_IN_PROGRESS");
      expect(r.httpStatus).toBe(409);
    }
  });
});

describe("cloneReadyResult", () => {
  it("returns CLONE_FAILED for error status or lastFetchError", () => {
    expect(
      cloneReadyResult({
        id: "r1",
        name: "x",
        indexedAt: null,
        lastCommitHash: "",
        cloneUrl: "https://github.com/o/r.git",
        status: "error",
        lastFetchError: "boom",
      })?.gate,
    ).toBe("CLONE_FAILED");
  });

  it("returns null when remote clone is ready", () => {
    expect(
      cloneReadyResult({
        id: "r1",
        name: "x",
        indexedAt: null,
        lastCommitHash: "",
        cloneUrl: "https://github.com/o/r.git",
        status: "idle",
        lastFetchError: null,
      }),
    ).toBeNull();
  });
});

describe("diffUnavailableResult", () => {
  it("maps sync failure to CLONE_FAILED / DIFF_UNAVAILABLE", () => {
    const clone = diffUnavailableResult(new Error("clone sync failed: timeout"), "r1");
    expect(clone.gate).toBe("CLONE_FAILED");
    expect(clone.ok).toBe(false);
    expect(clone.message).toContain("Clone or sync failed");
    expect(clone.httpStatus).toBe(503);

    const diff = diffUnavailableResult(new Error("unable to read tree"), "r1");
    expect(diff.gate).toBe("DIFF_UNAVAILABLE");
    expect(diff.message).toContain("Diff unavailable");
  });

  it("preludeFailToJson preserves gate codes", () => {
    const body = preludeFailToJson({
      ok: false,
      gate: "INDEX_REQUIRED",
      message: "index first",
      httpStatus: 409,
      repoId: "r1",
    });
    expect(body).toMatchObject({ error: "INDEX_REQUIRED", gate: "INDEX_REQUIRED", repoId: "r1" });
  });

  it("blocksExplicitAdmit includes CONFIG_REQUIRED for fail-fast prcheck", () => {
    expect(blocksExplicitAdmit("CONFIG_REQUIRED")).toBe(true);
    expect(blocksExplicitAdmit("INDEX_REQUIRED")).toBe(true);
    expect(blocksExplicitAdmit("INDEXING_IN_PROGRESS")).toBe(true);
    expect(blocksExplicitAdmit("REINDEX_FAILED")).toBe(true);
    expect(blocksExplicitAdmit("CLONE_FAILED")).toBe(true);
    // STALE is healed inside prelude; DIFF is checked after admit/sync
    expect(blocksExplicitAdmit("STALE_INDEX")).toBe(false);
    expect(blocksExplicitAdmit("DIFF_UNAVAILABLE")).toBe(false);
  });

  it("parseScanGate extracts codes from worker error messages", () => {
    expect(parseScanGate("INDEX_REQUIRED")).toBe("INDEX_REQUIRED");
    expect(parseScanGate("Blocked at DIFF_UNAVAILABLE. sync failed")).toBe("DIFF_UNAVAILABLE");
    expect(parseScanGate("SCAN_CONFIGURATION_REQUIRED")).toBe("CONFIG_REQUIRED");
    expect(parseScanGate("random failure")).toBeNull();
    expect(blockedAtLabel("CLONE_FAILED")).toBe("Blocked at CLONE_FAILED");
  });
});
