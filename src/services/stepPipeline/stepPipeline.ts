import { withRetry } from "./retry";
import {
  match,
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

      match(stepResult, {
        ok: (data) => {
          if (Array.isArray(data)) findings.push(...data);
        },
        err: (error, errFindings) => {
          if (errFindings) findings.push(...errFindings);
        },
      });

      const shouldAbort = match(stepResult, {
        ok: () => false as const,
        err: (error) => error.isInfrastructure || step.critical,
      });

      if (shouldAbort) {
        const infrastructureFailure = match(stepResult, {
          ok: () => false,
          err: (error) => error.isInfrastructure,
        });
        return {
          aborted: true,
          infrastructureFailure,
          stepResults,
          findings,
          lastStepName: step.name,
        };
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
