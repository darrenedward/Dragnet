import type { DeterministicFinding } from "../deterministicChecks";

export class StepError extends Error {
  isInfrastructure: boolean;

  constructor(message: string, isInfrastructure: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "StepError";
    this.isInfrastructure = isInfrastructure;
  }
}

export interface StepResult<T = void> {
  ok: boolean;
  data?: T;
  error?: StepError;
  findings?: DeterministicFinding[];
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
