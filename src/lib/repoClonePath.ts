/**
 * App-owned clone path markers for remote repos.
 *
 * Users never configure these. Remote GitHub/GitLab clones live in a Docker
 * volume (`dragnet-repo-<id>`) mounted at VOLUME_WORKSPACE_PATH inside the
 * alpine/git sidecar. `Repository.localPath` stores that marker so the app
 * knows the row is volume-backed — not a host filesystem path the operator
 * must invent.
 *
 * Legacy host clones may still use a real absolute host directory in
 * localPath or path; only those that exist on disk stay host-mode.
 */

import { existsSync } from "node:fs";

/** In-container mount point for named Docker volumes (git sidecar). */
export const VOLUME_WORKSPACE_PATH = "/workspace";

export function isVolumeWorkspacePath(localPath: string | null | undefined): boolean {
  return localPath == null || localPath === "" || localPath === VOLUME_WORKSPACE_PATH;
}

/**
 * Return a host filesystem path only if it actually exists on this process.
 * Phantom paths like `/app/repos/<id>` after redeploy return null → volume mode.
 */
export function usableHostLocalPath(localPath: string | null | undefined): string | null {
  if (isVolumeWorkspacePath(localPath)) return null;
  try {
    if (existsSync(localPath!)) return localPath!;
  } catch {
    /* ignore */
  }
  return null;
}

/** Remote clone with no usable host tree → Docker volume mode. */
export function isRemoteVolumeClone(repo: {
  path?: string | null;
  localPath?: string | null;
  cloneUrl?: string | null;
}): boolean {
  if (repo.path) return false;
  if (!repo.cloneUrl) return false;
  return usableHostLocalPath(repo.localPath) == null;
}
