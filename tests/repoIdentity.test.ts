import { describe, it, expect } from "vitest";
import { canonicalizeUrl, parseOwnerRepoFromUrl } from "../src/lib/repoIdentity";

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

  it("throws on unparseable URL", () => {
    expect(() => canonicalizeUrl("not-a-url")).toThrow("Cannot parse git remote URL");
  });

  it("throws on empty string", () => {
    expect(() => canonicalizeUrl("")).toThrow("Cannot parse git remote URL");
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
