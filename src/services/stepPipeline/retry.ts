import { StepError, isStepFailure, type StepResult } from "./types";

export interface RetryOptions {
  maxRetries: number;
  stepName: string;
  onRetry?: (attempt: number, error: StepError) => void;
}

export async function withRetry<T>(
  fn: () => Promise<StepResult<T>>,
  options: RetryOptions,
): Promise<StepResult<T>> {
  const { maxRetries, onRetry } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      if (isStepFailure(result)) {
        if (result.error.isInfrastructure && attempt < maxRetries) {
          onRetry?.(attempt + 1, result.error);
          continue;
        }
        return result;
      }
      return result;
    } catch (err: any) {
      const stepError = err instanceof StepError
        ? err
        : new StepError(err?.message ?? String(err), true);
      if (attempt < maxRetries) {
        onRetry?.(attempt + 1, stepError);
        continue;
      }
      return { ok: false, error: stepError };
    }
  }

  return {
    ok: false,
    error: new StepError(
      `${options.stepName}: exhausted retries after ${maxRetries + 1} attempts`,
      true,
    ),
  };
}
