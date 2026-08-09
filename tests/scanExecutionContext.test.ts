import { describe, expect, it } from "vitest";
import { resolveScanExecutionContext, ToolchainResolutionError } from "../src/services/deterministicChecks/scanExecutionContext";

describe("shared scan execution context", () => {
  it("produces the same evidence metadata from a tip reader", async () => {
    const context = await resolveScanExecutionContext({
      headSha: "a".repeat(40), source: "pr-tip",
      readFile: async (file) => ({ "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { test: "pnpm test" } }), "pnpm-lock.yaml": "lockfileVersion: '9.0'" }[file] ?? null),
    });
    expect(context.metadata).toMatchObject({ ecosystem: "node", image: "node:20-alpine", packageManager: { name: "pnpm" } });
    expect(context.metadata.fingerprint).toHaveLength(64);
  });

  it("turns resolver ambiguity into an actionable configuration error", async () => {
    await expect(resolveScanExecutionContext({
      headSha: "a".repeat(40), source: "pr-tip",
      readFile: async (file) => ({ "package.json": "{}", "package-lock.json": "{}", "yarn.lock": "" }[file] ?? null),
    })).rejects.toBeInstanceOf(ToolchainResolutionError);
  });
});
