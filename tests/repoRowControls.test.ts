import { describe, it, expect } from "vitest";
import { repoRowControls } from "../src/lib/repoRowControls";

/**
 * Layout-C declutter drops clone/index/webhook health from the sidebar,
 * but owned rows must keep a settings entry that opens full repo settings
 * (webhook, index, paths, keys, …). Shared rows keep prior access only.
 */
describe("repoRowControls", () => {
  it("owned rows expose settings + edit + mint key (settings opens full repo UI)", () => {
    const owned = repoRowControls("owner");
    expect(owned.showSettings).toBe(true);
    expect(owned.showEdit).toBe(true);
    expect(owned.showMintKey).toBe(true);
    expect(owned.showCloneFailIndicator).toBe(false);
    expect(owned.showPipelineHealthChips).toBe(false);
  });

  it("shared rows keep mint key only — no owner settings/edit lock-in beyond existing rules", () => {
    const shared = repoRowControls("shared");
    expect(shared.showSettings).toBe(false);
    expect(shared.showEdit).toBe(false);
    expect(shared.showMintKey).toBe(true);
    expect(shared.showCloneFailIndicator).toBe(false);
    expect(shared.showPipelineHealthChips).toBe(false);
  });

  it("settings control is discoverable via stable test id + onRepoSettings handler name", () => {
    const owned = repoRowControls("owner");
    expect(owned.showSettings).toBe(true);
    expect(owned.settingsTestId("repo-1")).toBe("sidebar-settings-button-repo-1");
    expect(owned.settingsHandler).toBe("onRepoSettings");
    expect(owned.settingsIcon).toBe("Settings");
  });

  it("shared rows do not advertise a settings test id (no accidental owner-only UI)", () => {
    const shared = repoRowControls("shared");
    expect(shared.showSettings).toBe(false);
    expect(shared.settingsTestId("repo-1")).toBeNull();
  });
});
