import { withRetry } from "./retry";
import {
  isStepSuccess,
  isStepFailure,
  type StepDefinition,
  type PipelineStepResult,
  type PipelineResult,
} from "./types";

export class StepPipeline {
  private steps: StepDefinition<any>[] = [];

  addStep<T>(step: StepDefinition<T>): void {
    this.steps.push(step);
  }

  async run(): Promise<PipelineResult> {
    const stepResults: PipelineStepResult[] = [];
    const findings: PipelineResult["findings"] = [];

    for (const step of this.steps) {
      const stepResult = await withRetry(step.fn, {
        maxRetries: step.maxRetries,
        stepName: step.name,
      });

      stepResults.push({ stepName: step.name, result: stepResult });

      if (isStepSuccess(stepResult)) {
        if (Array.isArray(stepResult.data)) {
          findings.push(...stepResult.data);
        }
      }

      if (isStepFailure(stepResult)) {
        if (stepResult.findings) {
          findings.push(...stepResult.findings);
        }

        if (stepResult.error.isInfrastructure) {
          return {
            aborted: true,
            infrastructureFailure: true,
            stepResults,
            findings,
            lastStepName: step.name,
          };
        }

        if (step.critical) {
          return {
            aborted: true,
            infrastructureFailure: false,
            stepResults,
            findings,
            lastStepName: step.name,
          };
        }
      }
    }

    return {
      aborted: false,
      infrastructureFailure: false,
      stepResults,
      findings,
    };
  }
}
