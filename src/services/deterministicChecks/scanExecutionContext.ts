import {
  resolveToolchainFromReader,
  type ResolvedToolchain,
  type TipTreeReader,
  type ToolchainConfiguration,
  type ToolchainRepositoryOverrides,
} from "./toolchainResolver";
import type { ToolchainEvidenceMetadata } from "./executionEvidence";

export class ToolchainResolutionError extends Error {
  readonly kind: "configuration" | "infrastructure";
  readonly toolchain: ResolvedToolchain;

  constructor(toolchain: ResolvedToolchain) {
    super(`Toolchain resolution ${toolchain.status}: ${toolchain.conflicts.join("; ")}`);
    this.name = "ToolchainResolutionError";
    this.kind = toolchain.status === "ambiguous" ? "configuration" : "infrastructure";
    this.toolchain = toolchain;
  }
}

export interface ScanExecutionContext {
  readonly toolchain: ResolvedToolchain;
  readonly metadata: ToolchainEvidenceMetadata;
}

export function executionMetadataFromToolchain(toolchain: ResolvedToolchain): ToolchainEvidenceMetadata {
  return {
    ecosystem: toolchain.identity?.ecosystem ?? null,
    runtime: toolchain.identity?.runtime ?? {},
    image: toolchain.execution.image,
    packageManager: toolchain.identity?.packageManager,
    lockfiles: toolchain.identity?.lockfiles ?? [],
    workspace: toolchain.configuration?.workspace ?? ".",
    commands: toolchain.execution.qualityCommands,
    fingerprint: toolchain.fingerprint,
  };
}

export async function resolveScanExecutionContext(input: TipTreeReader & {
  configuration?: ToolchainConfiguration;
  repositoryOverrides?: ToolchainRepositoryOverrides;
}): Promise<ScanExecutionContext> {
  const toolchain = await resolveToolchainFromReader(input);
  if (toolchain.status !== "resolved" || !toolchain.execution.image || !toolchain.execution.installCommand) {
    throw new ToolchainResolutionError(toolchain);
  }
  return {
    toolchain,
    metadata: {
      ...executionMetadataFromToolchain(toolchain),
    },
  };
}
