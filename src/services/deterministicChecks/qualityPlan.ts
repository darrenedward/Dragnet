import type { ResolvedQualityCommand, CheckKind } from "./toolchainResolver";

export type QualityResultStatus = "passed" | "findings" | "skipped_dependency" | "infrastructure_failure";

export interface QualityCommandResult {
  readonly command: ResolvedQualityCommand;
  readonly status: QualityResultStatus;
  readonly reason?: string;
}

/** Plans checks without allowing an unavailable optional service to hide static findings. */
export function planQualityChecks(
  checks: Readonly<Record<CheckKind, readonly ResolvedQualityCommand[]>>,
  availableServices: ReadonlySet<string>,
): readonly QualityCommandResult[] {
  const result: QualityCommandResult[] = [];
  for (const kind of ["static", "unit", "integration", "e2e"] as const) {
    for (const command of checks[kind]) {
      const missing = command.requiresServices.filter((service) => !availableServices.has(service));
      if (missing.length > 0 && command.optional) {
        result.push({
          command,
          status: "skipped_dependency",
          reason: `Optional service unavailable: ${missing.join(", ")}`,
        });
      } else if (missing.length > 0) {
        result.push({ command, status: "infrastructure_failure", reason: `Required service unavailable: ${missing.join(", ")}` });
      } else {
        result.push({ command, status: "passed" });
      }
    }
  }
  return result;
}

/** Only variables explicitly declared for build-time use are eligible for injection. */
export function buildTimeEnvironment(command: ResolvedQualityCommand): Readonly<Record<string, string>> {
  return Object.fromEntries(command.buildTimeEnvironment
    .filter((key) => key in command.environment)
    .map((key) => [key, command.environment[key]]));
}
