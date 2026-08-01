import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import {
  VOLUME_WORKSPACE_PATH,
  isVolumeWorkspacePath,
  usableHostLocalPath,
  isRemoteVolumeClone,
} from "../src/lib/repoClonePath";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

describe("repoClonePath", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it("treats null and /workspace as volume markers", () => {
    expect(isVolumeWorkspacePath(null)).toBe(true);
    expect(isVolumeWorkspacePath(undefined)).toBe(true);
    expect(isVolumeWorkspacePath("")).toBe(true);
    expect(isVolumeWorkspacePath(VOLUME_WORKSPACE_PATH)).toBe(true);
    expect(isVolumeWorkspacePath("/tmp/real")).toBe(false);
  });

  it("usableHostLocalPath only returns existing host directories", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(usableHostLocalPath("/app/repos/missing")).toBeNull();
    vi.mocked(existsSync).mockReturnValue(true);
    expect(usableHostLocalPath("/tmp/legacy-repo")).toBe("/tmp/legacy-repo");
    expect(usableHostLocalPath(VOLUME_WORKSPACE_PATH)).toBeNull();
  });

  it("isRemoteVolumeClone is true for cloneUrl without host tree", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(
      isRemoteVolumeClone({
        path: null,
        localPath: "/app/repos/x",
        cloneUrl: "https://github.com/o/r.git",
      }),
    ).toBe(true);
    expect(
      isRemoteVolumeClone({
        path: "/home/user/proj",
        localPath: null,
        cloneUrl: null,
      }),
    ).toBe(false);
  });
});
