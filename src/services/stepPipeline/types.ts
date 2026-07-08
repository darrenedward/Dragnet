import type { DeterministicFinding } from "../deterministicChecks";

export class StepError extends Error {
  isInfrastructure: boolean;

  constructor(message: string, isInfrastructure: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "StepError";
    this.isInfrastructure = isInfrastructure;
  }
}

export type StepResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StepError; findings?: DeterministicFinding[] };

export function isStepSuccess<T>(r: StepResult<T>): r is { ok: true; data: T } {
  return r.ok;
}

export function isStepFailure<T>(r: StepResult<T>): r is { ok: false; error: StepError; findings?: DeterministicFinding[] } {
  return !r.ok;
}

export function match<T, R>(
  result: StepResult<T>,
  handlers: {
    ok: (data: T) => R;
    err: (error: StepError, findings?: DeterministicFinding[]) => R;
  },
): R {
  if (isStepSuccess(result)) {
    return handlers.ok(result.data);
  }
  return handlers.err(result.error, result.findings);
}

export interface StepDefinition<T = any> {
  name: string;
  critical: boolean;
  maxRetries: number;
  fn: () => Promise<StepResult<T>>;
}

export interface PipelineStepResult {
  stepName: string;
  result: StepResult<any>;
}

export interface PipelineResult {
  aborted: boolean;
  infrastructureFailure: boolean;
  stepResults: PipelineStepResult[];
  findings: DeterministicFinding[];
  lastStepName?: string;
}
