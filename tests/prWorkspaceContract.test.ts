import { describe, expect, it, vi } from "vitest";
import { createPrWorkspaceContract } from "../src/lib/prWorkspaceContract";

describe("PR workspace consumer contract", () => {
  it("keeps review read-model data and named commands together", () => {
    const commands = {
      selectRepository: vi.fn(),
      selectPullRequest: vi.fn(),
      selectFile: vi.fn(),
      dismissScanResult: vi.fn(),
      dismissTrivialSkipNotice: vi.fn(),
      startScan: vi.fn(),
      stopScan: vi.fn(),
      continueScan: vi.fn(),
      startFreshScan: vi.fn(),
      retryFailedChunks: vi.fn(),
      exportReview: vi.fn(),
      copySuggestion: vi.fn(),
    };
    const workspace = createPrWorkspaceContract(
      {
        selectedRepoId: "repo-a",
        selectedPrId: "pr-a",
        files: [{ filename: "src/app.ts" }],
        findings: [{ id: "finding-a" }],
        progress: { isScanning: true },
        feedback: { copyFeedback: "src/app.ts" },
      },
      commands,
    );

    expect(workspace.readModel.selectedRepoId).toBe("repo-a");
    expect(workspace.readModel.selectedPrId).toBe("pr-a");
    expect(workspace.readModel.files[0].filename).toBe("src/app.ts");
    expect(workspace.readModel.findings[0].id).toBe("finding-a");
    expect(workspace.readModel.progress.isScanning).toBe(true);
    expect(workspace.readModel.feedback.copyFeedback).toBe("src/app.ts");

    workspace.commands.selectPullRequest("pr-b");
    workspace.commands.startScan();
    workspace.commands.stopScan();
    workspace.commands.continueScan("pr-a");
    workspace.commands.startFreshScan("pr-a");
    workspace.commands.retryFailedChunks();
    workspace.commands.exportReview("download");
    workspace.commands.copySuggestion("fix", "finding-a");
    workspace.commands.selectFile("src/app.ts");
    workspace.commands.dismissScanResult();
    workspace.commands.dismissTrivialSkipNotice();

    expect(commands.selectPullRequest).toHaveBeenCalledWith("pr-b");
    expect(commands.startScan).toHaveBeenCalled();
    expect(commands.stopScan).toHaveBeenCalled();
    expect(commands.continueScan).toHaveBeenCalledWith("pr-a");
    expect(commands.startFreshScan).toHaveBeenCalledWith("pr-a");
    expect(commands.retryFailedChunks).toHaveBeenCalled();
    expect(commands.exportReview).toHaveBeenCalledWith("download");
    expect(commands.copySuggestion).toHaveBeenCalledWith("fix", "finding-a");
    expect(commands.selectFile).toHaveBeenCalledWith("src/app.ts");
  });
});
