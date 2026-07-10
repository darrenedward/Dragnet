import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContainerOrchestrator } from "../src/lib/containerOrchestrator";

const mockExecFileSync = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockCreateVolume = vi.fn();
const mockRunRunner = vi.fn();
const mockCopyVolumeToHost = vi.fn();
const mockIndexFolder = vi.fn();
const mockGetInstallationToken = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process") as typeof import("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => mockExecFileSync(...args),
  };
});

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock("../src/lib/containerOrchestrator", () => ({
  ContainerOrchestrator: {
    getInstance: () => ({
      createVolume: (...args: unknown[]) => mockCreateVolume(...args),
      runRunner: (...args: unknown[]) => mockRunRunner(...args),
      copyVolumeToHost: (...args: unknown[]) => mockCopyVolumeToHost(...args),
    }),
    setInstance: vi.fn(),
  },
  detectContainerEngine: () => "docker",
}));

vi.mock("../src/services/indexingService", () => ({
  IndexingService: { indexFolder: (...args: unknown[]) => mockIndexFolder(...args) },
}));

vi.mock("../src/lib/githubApp", () => ({
  getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
}));

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-repo-1",
    name: "test-repo",
    provider: "remote",
    cloneUrl: "git@github.com:owner/repo.git",
    cloneUrlHttps: null,
    deployKeyCipher: null,
    deployKeyIv: null,
    deployKeyTag: null,
    patCipher: null,
    patIv: null,
    patTag: null,
    localPath: null,
    installationId: null,
    lastFetchAt: null,
    status: "cloning",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!process.env.DRAGNET_MASTER_KEY) {
    process.env.DRAGNET_MASTER_KEY = "QQe7IAjrJKIUR/yBCcjdW91OJXQt2zVQsm9NvZqXjzc=";
  }
  mockRunRunner.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  mockCopyVolumeToHost.mockResolvedValue(undefined);
});

afterEach(() => {
  ContainerOrchestrator["instance"] = null;
});

describe("isFetching", () => {
  it("returns false for unknown repoId", async () => {
    const { isFetching } = await import("../src/services/remoteFetchWorker");
    expect(isFetching("unknown")).toBe(false);
  });
});

describe("enqueue", () => {
  it("returns null when repo is already being fetched", async () => {
    const { enqueue } = await import("../src/services/remoteFetchWorker");
    let resolveFind: (v: unknown) => void;
    const findPromise = new Promise((resolve) => { resolveFind = resolve; });
    mockFindUnique.mockReturnValue(findPromise);

    const firstCall = enqueue("test-repo-1");
    // Second call should return null while first is still in-flight
    const secondResult = await enqueue("test-repo-1");
    expect(secondResult).toBeNull();

    resolveFind!(makeRepo());
    // Ensure the first call eventually resolves (cleanup activeFetches)
    await expect(firstCall).resolves.toBe("/workspace");
  });

  it("throws when repo is not found", async () => {
    const { enqueue } = await import("../src/services/remoteFetchWorker");
    mockFindUnique.mockResolvedValue(null);
    await expect(enqueue("no-such-repo")).rejects.toThrow("Repository not found");
  });

  it("throws when repo is local type", async () => {
    const { enqueue } = await import("../src/services/remoteFetchWorker");
    mockFindUnique.mockResolvedValue(makeRepo({ provider: "local", cloneUrl: null }));
    await expect(enqueue("test-repo-1")).rejects.toThrow("not a remote repo");
  });

  it("throws when repo has no cloneUrl", async () => {
    const { enqueue } = await import("../src/services/remoteFetchWorker");
    mockFindUnique.mockResolvedValue(makeRepo({ cloneUrl: null }));
    await expect(enqueue("test-repo-1")).rejects.toThrow("not a remote repo");
  });

  describe("container mode — new clone", () => {
    it("creates volume and clones via ContainerOrchestrator", async () => {
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo());

      const result = await enqueue("test-repo-1");

      expect(result).toBe("/workspace");
      expect(mockCreateVolume).toHaveBeenCalledWith("dragnet-repo-test-repo-1");
      expect(mockRunRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          volumeName: "dragnet-repo-test-repo-1",
          image: "alpine/git",
          networkMode: "bridge",
          timeoutMs: 300_000,
        }),
      );
      // The script runs as a single combined `set -e && ...` shell
      // invocation. Assert on the contents of the script, not its shape.
      expect(mockRunRunner.mock.calls[0][0].commands[0]).toContain("git init");
      expect(mockRunRunner.mock.calls[0][0].commands[0]).toContain("cd /workspace");
      expect(mockRunRunner.mock.calls[0][0].commands[0]).toContain("git fetch origin --prune");
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "test-repo-1" },
          data: expect.objectContaining({ localPath: "/workspace" }),
        }),
      );
      expect(mockCopyVolumeToHost).toHaveBeenCalledWith(
        "dragnet-repo-test-repo-1",
        expect.stringContaining("dragnet-idx-test-repo-1-"),
        "alpine/git",
      );
      expect(mockIndexFolder).toHaveBeenCalledWith(
        "test-repo-1",
        expect.stringContaining("dragnet-idx-test-repo-1-"),
      );
    });

    it("indexes via copy from volume", async () => {
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo());

      await enqueue("test-repo-1");

      expect(mockCopyVolumeToHost).toHaveBeenCalledTimes(1);
      expect(mockIndexFolder).toHaveBeenCalledTimes(1);
    });

    it("uses PAT for HTTPS auth when provided", async () => {
      const { encryptSecret } = await import("../src/lib/crypto");
      const { cipher, iv, tag } = encryptSecret("ghp_fakePAT");
      const { enqueue } = await import("../src/services/remoteFetchWorker");

      mockFindUnique.mockResolvedValue(
        makeRepo({
          cloneUrl: "https://github.com/owner/repo.git",
          patCipher: cipher,
          patIv: iv,
          patTag: tag,
        }),
      );

      const result = await enqueue("test-repo-1");

      expect(result).toBe("/workspace");
      const command = mockRunRunner.mock.calls[0][0].commands[0];
      expect(command).toContain("x-access-token");
      expect(command).toContain("ghp_fakePAT");
    });

    it("falls back to installation token when no deployKey or PAT", async () => {
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockGetInstallationToken.mockResolvedValue("inst-token-123");
      mockFindUnique.mockResolvedValue(makeRepo({ installationId: 42 }));

      await enqueue("test-repo-1");

      expect(mockGetInstallationToken).toHaveBeenCalledWith(42);
    });
  });

  describe("container mode — existing containerized repo", () => {
    it("re-fetches without re-initializing when .git exists", async () => {
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo({ localPath: "/workspace" }));

      const result = await enqueue("test-repo-1");

      expect(result).toBe("/workspace");
      expect(mockCreateVolume).toHaveBeenCalled();
      const command = mockRunRunner.mock.calls[0][0].commands[0];
      // The init + remote-set-url is wrapped in `( ... 2>/dev/null || ... )`
      // so a pre-existing .git + remote config is tolerated on re-fetch.
      expect(command).toContain("git init");
      expect(command).toContain("cd /workspace");
      expect(command).toContain("git remote add origin");
      expect(command).toContain("git fetch origin --prune");
      expect(mockUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ localPath: expect.anything() }),
        }),
      );
      expect(mockCopyVolumeToHost).toHaveBeenCalledTimes(1);
      expect(mockIndexFolder).toHaveBeenCalledTimes(1);
    });
  });

  describe("host mode — legacy repo", () => {
    it("runs git fetch on host and indexes", async () => {
      mockExecFileSync.mockReturnValue("");
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo({ localPath: "/tmp/legacy-repo" }));

      const result = await enqueue("test-repo-1");

      expect(result).toBe("/tmp/legacy-repo");
      expect(mockCreateVolume).not.toHaveBeenCalled();
      expect(mockRunRunner).not.toHaveBeenCalled();
      // The host-mode fetch adds +refs/heads/*:refs/heads/* to keep
      // remote-only branches alive (otherwise `git fetch --prune`
      // deletes them from the local clone).
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["-C", "/tmp/legacy-repo", "fetch", "origin", "--prune", "+refs/heads/*:refs/heads/*"],
        expect.objectContaining({ timeout: 120_000 }),
      );
      expect(mockIndexFolder).toHaveBeenCalledWith("test-repo-1", "/tmp/legacy-repo");
    });

    it("updates lastFetchAt in host mode", async () => {
      mockExecFileSync.mockReturnValue("");
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo({ localPath: "/tmp/legacy-repo" }));

      await enqueue("test-repo-1");

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "test-repo-1" },
          data: expect.objectContaining({ lastFetchAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe("error handling", () => {
    it("throws when git sync fails (non-zero exit)", async () => {
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo());
      mockRunRunner.mockResolvedValue({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: repository not found",
        timedOut: false,
      });

      await expect(enqueue("test-repo-1")).rejects.toThrow("Git sync failed");
    });

    it("throws when git sync times out", async () => {
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo());
      mockRunRunner.mockResolvedValue({
        exitCode: -1,
        stdout: "",
        stderr: "",
        timedOut: true,
      });

      await expect(enqueue("test-repo-1")).rejects.toThrow("timed out");
    });

    it("throws when DRAGNET_MASTER_KEY is not set and deployKey is present", async () => {
      delete (globalThis as any).__dragnetCryptoKey;
      delete process.env.DRAGNET_MASTER_KEY;
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(
        makeRepo({
          deployKeyCipher: "cipher",
          deployKeyIv: "iv",
          deployKeyTag: "tag",
        }),
      );

      await expect(enqueue("test-repo-1")).rejects.toThrow("DRAGNET_MASTER_KEY is not set");
    });
  });

  describe("lastFetchAt update", () => {
    it("updates lastFetchAt after successful clone", async () => {
      const { enqueue } = await import("../src/services/remoteFetchWorker");
      mockFindUnique.mockResolvedValue(makeRepo());

      await enqueue("test-repo-1");

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "test-repo-1" },
          data: expect.objectContaining({ lastFetchAt: expect.any(Date) }),
        }),
      );
    });
  });
});
