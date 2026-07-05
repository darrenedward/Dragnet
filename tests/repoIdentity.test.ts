import { describe, it, expect } from "vitest";
import { canonicalizeUrl, computeRepoId, computeLocalRepoId, parseOwnerRepoFromUrl } from "../src/lib/repoIdentity";

describe("canonicalizeUrl", () => {
  it("normalizes GitHub SSH URL", () => {
    expect(canonicalizeUrl("git@github.com:owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("normalizes GitHub SSH URL without .git suffix", () => {
    expect(canonicalizeUrl("git@github.com:owner/repo"))
      .toBe("https://github.com/owner/repo");
  });

  it("normalizes GitHub HTTPS URL", () => {
    expect(canonicalizeUrl("https://github.com/owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("normalizes GitHub HTTPS URL without .git suffix", () => {
    expect(canonicalizeUrl("https://github.com/owner/repo"))
      .toBe("https://github.com/owner/repo");
  });

  it("normalizes GitLab SSH URL", () => {
    expect(canonicalizeUrl("git@gitlab.com:owner/repo.git"))
      .toBe("https://gitlab.com/owner/repo");
  });

  it("normalizes GitLab HTTPS URL", () => {
    expect(canonicalizeUrl("https://gitlab.com/owner/repo.git"))
      .toBe("https://gitlab.com/owner/repo");
  });

  it("normalizes self-hosted SSH URL", () => {
    expect(canonicalizeUrl("git@git.internal.example.com:team/project.git"))
      .toBe("https://git.internal.example.com/team/project");
  });

  it("normalizes git:// protocol URL", () => {
    expect(canonicalizeUrl("git://github.com/owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("normalizes SSH URL with port in hostname", () => {
    expect(canonicalizeUrl("git@github.com:owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("strips userinfo from HTTPS URL", () => {
    expect(canonicalizeUrl("https://token@github.com/owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("strips port from HTTPS URL", () => {
    expect(canonicalizeUrl("https://github.com:8443/owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("lowercases host and path", () => {
    expect(canonicalizeUrl("https://GITHUB.COM/OWNER/REPO"))
      .toBe("https://github.com/owner/repo");
  });

  it("strips trailing slash from path", () => {
    expect(canonicalizeUrl("https://github.com/owner/repo/"))
      .toBe("https://github.com/owner/repo");
  });

  it("lowercases SSH host and path", () => {
    expect(canonicalizeUrl("git@GITHUB.COM:OWNER/REPO.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("throws on unparseable URL", () => {
    expect(() => canonicalizeUrl("not-a-url")).toThrow("Cannot parse git remote URL");
  });

  it("throws on empty string", () => {
    expect(() => canonicalizeUrl("")).toThrow("Cannot parse git remote URL");
  });
});

describe("computeRepoId", () => {
  it("derives repoId from GitHub SSH URL", () => {
    expect(computeRepoId("git@github.com:owner/repo.git")).toBe("github.com/owner/repo");
  });

  it("derives repoId from GitHub HTTPS URL", () => {
    expect(computeRepoId("https://github.com/owner/repo.git")).toBe("github.com/owner/repo");
  });

  it("derives repoId from git:// URL", () => {
    expect(computeRepoId("git://github.com/owner/repo.git")).toBe("github.com/owner/repo");
  });

  it("derives same repoId for SSH and HTTPS variants", () => {
    const ssh = computeRepoId("git@github.com:owner/repo.git");
    const https = computeRepoId("https://github.com/owner/repo.git");
    expect(ssh).toBe(https);
  });

  it("derives same repoId with and without .git suffix", () => {
    const withGit = computeRepoId("git@github.com:owner/repo.git");
    const withoutGit = computeRepoId("git@github.com:owner/repo");
    expect(withGit).toBe(withoutGit);
  });

  it("throws on unparseable URL", () => {
    expect(() => computeRepoId("not-a-url")).toThrow("Cannot parse git remote URL");
  });
});

describe("computeLocalRepoId", () => {
  it("returns local/<sha256-prefix> format", () => {
    const id = computeLocalRepoId("/home/user/my-project");
    expect(id).toMatch(/^local\/[0-9a-f]{16}$/);
  });

  it("returns consistent ID for same path", () => {
    const a = computeLocalRepoId("/home/user/my-project");
    const b = computeLocalRepoId("/home/user/my-project");
    expect(a).toBe(b);
  });

  it("returns different IDs for different paths", () => {
    const a = computeLocalRepoId("/home/user/project-a");
    const b = computeLocalRepoId("/home/user/project-b");
    expect(a).not.toBe(b);
  });
});

describe("parseOwnerRepoFromUrl", () => {
  it("extracts owner and repo from canonical GitHub URL", () => {
    expect(parseOwnerRepoFromUrl("https://github.com/owner/repo"))
      .toEqual({ owner: "owner", repo: "repo" });
  });

  it("extracts owner and repo with hyphens", () => {
    expect(parseOwnerRepoFromUrl("https://gitlab.com/my-org/my-project"))
      .toEqual({ owner: "my-org", repo: "my-project" });
  });

  it("extracts owner and repo from self-hosted", () => {
    expect(parseOwnerRepoFromUrl("https://git.company.com/team/app"))
      .toEqual({ owner: "team", repo: "app" });
  });

  it("throws on invalid URL", () => {
    expect(() => parseOwnerRepoFromUrl("not-a-url")).toThrow("Cannot parse owner/repo");
  });
});
