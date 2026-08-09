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
    workspaces: toolchain.execution.workspaces,
    commands: toolchain.execution.qualityCommands,
    servicePolicy: Object.fromEntries(Object.entries(toolchain.execution.checks ?? {}).map(([kind, commands]) => [
      kind,
      commands.filter((command) => command.requiresServices.length > 0).map((command) => ({ command: command.command, services: command.requiresServices })),
    ])),
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
