import { describe, it, expect } from "vitest";
import {
  splitSidebarRepos,
  type SidebarRepo,
  type SidebarUserRepo,
} from "../src/lib/sidebarFilters";

const repo = (id: string, name: string, ownerId: string | null): SidebarRepo => ({
  id,
  name,
  ownerId,
});

const userRepo = (
  userId: string,
  repoId: string,
  role: "admin" | "member",
  invitedAt: string,
): SidebarUserRepo => ({ userId, repoId, role, invitedAt });

describe("splitSidebarRepos", () => {
  it("returns empty arrays when there are no repos", () => {
    const out = splitSidebarRepos([], [], "u1");
    expect(out.yourProjects).toEqual([]);
    expect(out.sharedProjects).toEqual([]);
  });

  it("'Your projects' lists repos where the current user is the owner", () => {
    const repos = [repo("r1", "Alpha", "u1"), repo("r2", "Beta", "u2")];
    const out = splitSidebarRepos(repos, [], "u1");
    expect(out.yourProjects.map((r) => r.id)).toEqual(["r1"]);
    expect(out.sharedProjects).toEqual([]);
  });

  it("'Shared with you' lists repos where the current user has a UserRepo row but is not the owner", () => {
    const repos = [
      repo("r1", "Mine", "u1"),
      repo("r2", "Theirs", "u2"),
    ];
    const userRepos = [userRepo("u1", "r2", "member", "2026-01-01T00:00:00Z")];
    const out = splitSidebarRepos(repos, userRepos, "u1");
    expect(out.yourProjects.map((r) => r.id)).toEqual(["r1"]);
    expect(out.sharedProjects.map((r) => r.id)).toEqual(["r2"]);
  });

  it("'Shared with you' excludes repos where the current user IS the owner (even with a UserRepo row)", () => {
    const repos = [repo("r1", "Mine", "u1")];
    const userRepos = [userRepo("u1", "r1", "admin", "2026-01-01T00:00:00Z")];
    const out = splitSidebarRepos(repos, userRepos, "u1");
    expect(out.yourProjects.map((r) => r.id)).toEqual(["r1"]);
    expect(out.sharedProjects).toEqual([]);
  });

  it("'Shared with you' remains alphabetically ordered as projects change", () => {
    const repos = [
      repo("r1", "Old", "u2"),
      repo("r2", "New", "u2"),
      repo("r3", "Mid", "u2"),
    ];
    const userRepos = [
      userRepo("u1", "r1", "member", "2026-01-01T00:00:00Z"),
      userRepo("u1", "r2", "member", "2026-03-01T00:00:00Z"),
      userRepo("u1", "r3", "member", "2026-02-01T00:00:00Z"),
    ];
    const out = splitSidebarRepos(repos, userRepos, "u1");
    expect(out.sharedProjects.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
  });

  it("shared repos with no matching Repository row are dropped", () => {
    const repos = [repo("r1", "Mine", "u1")];
    const userRepos = [
      userRepo("u1", "r1", "member", "2026-01-01T00:00:00Z"),
      userRepo("u1", "r-orphan", "member", "2026-02-01T00:00:00Z"),
    ];
    const out = splitSidebarRepos(repos, userRepos, "u1");
    expect(out.sharedProjects).toEqual([]);
  });

  it("removal-after-revoke: when a UserRepo row is removed, the repo disappears from 'Shared with you'", () => {
    const repos = [repo("r1", "Mine", "u1"), repo("r2", "Theirs", "u2")];
    const before = splitSidebarRepos(
      repos,
      [userRepo("u1", "r2", "member", "2026-01-01T00:00:00Z")],
      "u1",
    );
    expect(before.sharedProjects.map((r) => r.id)).toEqual(["r2"]);

    const after = splitSidebarRepos(repos, [], "u1");
    expect(after.sharedProjects).toEqual([]);
  });

  it("owner with null ownerId is treated as not-mine (no false-positive in Your projects)", () => {
    const repos = [repo("r1", "Unowned", null)];
    const out = splitSidebarRepos(repos, [], "u1");
    expect(out.yourProjects).toEqual([]);
    expect(out.sharedProjects).toEqual([]);
  });

  it("shared repos carry the role on the row (used by the row to gate edit/settings)", () => {
    const repos = [repo("r1", "Theirs", "u2")];
    const userRepos = [userRepo("u1", "r1", "admin", "2026-01-01T00:00:00Z")];
    const out = splitSidebarRepos(repos, userRepos, "u1");
    expect(out.sharedProjects[0].role).toBe("admin");
  });
});
