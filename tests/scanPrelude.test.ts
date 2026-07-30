import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runScanPrelude,
  diffUnavailableResult,
  preludeFailToJson,
  blocksExplicitAdmit,
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

  it("blocks on CONFIG_REQUIRED before index work", async () => {
    deps.getConfigurationIssues = () => [
      { role: "chat", label: "Chat", provider: null, reason: "missing_provider" },
    ];
    const r = await runScanPrelude(repo, deps);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.gate).toBe("CONFIG_REQUIRED");
      expect(r.httpStatus).toBe(400);
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
    if (r.ok === false) expect(r.gate).toBe("INDEX_REQUIRED");
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

describe("diffUnavailableResult", () => {
  it("maps sync failure to CLONE_FAILED / DIFF_UNAVAILABLE", () => {
    const clone = diffUnavailableResult(new Error("clone sync failed: timeout"), "r1");
    expect(clone.gate).toBe("CLONE_FAILED");
    expect(clone.ok).toBe(false);

    const diff = diffUnavailableResult(new Error("unable to read tree"), "r1");
    expect(diff.gate).toBe("DIFF_UNAVAILABLE");
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
});
