/**
 * Pure helper that powers the unified sidebar. Given the full
 * repository list + the current user's `UserRepo` rows, returns
 * the two sections the sidebar renders:
 *
 *   - `yourProjects`: repos where `ownerId === currentUserId`
 *   - `sharedProjects`: repos the user has a `UserRepo` row for,
 *     but is NOT the owner of. Ordered by `invitedAt` desc.
 *
 * Sidebar rendering and component tests should consume the
 * `splitSidebarRepos` output — keep the JSX dumb.
 */

export type SidebarRepo = {
  id: string;
  name: string;
  ownerId?: string | null;
};

export type SidebarUserRepo = {
  userId: string;
  repoId: string;
  role: "admin" | "member";
  invitedAt: string; // ISO
};

export type SidebarSection = {
  id: string;
  name: string;
  ownerId: string | null;
  role: "admin" | "member" | null;
  invitedAt: string | null;
};

export type SidebarSplit = {
  yourProjects: SidebarSection[];
  sharedProjects: SidebarSection[];
};

export function splitSidebarRepos(
  repos: SidebarRepo[],
  userRepos: SidebarUserRepo[],
  currentUserId: string,
): SidebarSplit {
  const yourProjects: SidebarSection[] = [];
  const sharedMap = new Map<string, SidebarSection>();

  for (const r of repos) {
    if (r.ownerId === currentUserId) {
      yourProjects.push({
        id: r.id,
        name: r.name,
        ownerId: r.ownerId,
        role: null,
        invitedAt: null,
      });
    }
  }

  for (const ur of userRepos) {
    if (ur.userId !== currentUserId) continue;
    const repo = repos.find((r) => r.id === ur.repoId);
    if (!repo) continue; // orphan UserRepo — repo was deleted
    if (repo.ownerId === currentUserId) continue; // owner, not shared
    const existing = sharedMap.get(ur.repoId);
    if (existing) {
      // Multiple UserRepo rows for the same (user, repo) shouldn't
      // happen — the schema enforces @@unique([userId, repoId]) — but
      // if it does, keep the highest-privileged role.
      if (ur.role === "admin" && existing.role !== "admin") {
        existing.role = "admin";
      }
      continue;
    }
    sharedMap.set(ur.repoId, {
      id: repo.id,
      name: repo.name,
      ownerId: repo.ownerId,
      role: ur.role,
      invitedAt: ur.invitedAt,
    });
  }

  const sharedProjects = [...sharedMap.values()].sort((a, b) => {
    if (!a.invitedAt) return 1;
    if (!b.invitedAt) return -1;
    return b.invitedAt.localeCompare(a.invitedAt);
  });

  return { yourProjects, sharedProjects };
}
