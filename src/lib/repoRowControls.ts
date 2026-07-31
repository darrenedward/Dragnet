/**
 * Sidebar repo-row control policy (layout-C).
 *
 * Declutter removes clone-fail X and pipeline health chips from the nav.
 * Owned rows still expose a settings cog that opens full repo settings
 * via `onRepoSettings` (webhook, index, paths, keys, …). Shared rows keep
 * the prior surface: mint key only — no owner settings/edit.
 */

export type RepoRowMode = "owner" | "shared";

export type RepoRowControls = {
  showSettings: boolean;
  showEdit: boolean;
  showMintKey: boolean;
  /** Always false under layout-C — clone state lives on the PR header chip. */
  showCloneFailIndicator: boolean;
  /** Always false under layout-C — do not put webhook/index chips in the nav. */
  showPipelineHealthChips: boolean;
  /** Lucide icon name for the settings entry (gear). */
  settingsIcon: "Settings";
  /** App callback that must open RepoSettingsModal (all tabs). */
  settingsHandler: "onRepoSettings";
  settingsTestId: (repoId: string) => string | null;
};

export function repoRowControls(mode: RepoRowMode): RepoRowControls {
  const isOwner = mode === "owner";
  return {
    showSettings: isOwner,
    showEdit: isOwner,
    showMintKey: true,
    showCloneFailIndicator: false,
    showPipelineHealthChips: false,
    settingsIcon: "Settings",
    settingsHandler: "onRepoSettings",
    settingsTestId: (repoId) =>
      isOwner ? `sidebar-settings-button-${repoId}` : null,
  };
}
