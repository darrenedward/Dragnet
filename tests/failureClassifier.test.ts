import { describe, expect, it } from "vitest";
import {
  classifyProviderOutcome,
  isRetryableError,
  MALFORMED_STREAK_THRESHOLD,
  type ClassifyInput,
} from "../src/lib/failureClassifier";

/** Base fixture — happy-path inputs. Each test mutates one field. */
const baseInput: ClassifyInput = {
  error: null,
  submitReviewCalled: true,
  rating: 8,
  iterationsUsed: 4,
  maxIterations: 4,
  malformedStreak: 0,
  interrupted: false,
  refusalDetected: false,
  emptyFindings: false,
};

/** Build an HTTP-error-shaped object like the OpenAI SDK throws. */
function httpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

/** Build a Node-style syscall error. */
function sysError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("classifyProviderOutcome — rule 1 (interrupted)", () => {
  it("returns interrupted when flag is true", () => {
    expect(classifyProviderOutcome({ ...baseInput, interrupted: true })).toBe("interrupted");
  });

  it("returns interrupted when error.name is AbortError, even with no flag", () => {
    const err = new Error("The user aborted a request") as Error;
    err.name = "AbortError";
    expect(classifyProviderOutcome({ ...baseInput, error: err })).toBe("interrupted");
  });

  it("interrupted flag beats a retryable transport error", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        interrupted: true,
        error: httpError(429),
      }),
    ).toBe("interrupted");
  });
});

describe("classifyProviderOutcome — rule 2 (transport_failure)", () => {
  it.each([408, 409, 425, 429, 500, 502, 503, 504])("HTTP %d → transport_failure", (status) => {
    expect(classifyProviderOutcome({ ...baseInput, error: httpError(status) })).toBe(
      "transport_failure",
    );
  });

  it.each(["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"])(
    "syscall %s → transport_failure",
    (code) => {
      expect(classifyProviderOutcome({ ...baseInput, error: sysError(code) })).toBe(
        "transport_failure",
      );
    },
  );

  it("message containing 'rate limit' → transport_failure", () => {
    expect(
      classifyProviderOutcome({ ...baseInput, error: new Error("rate limit exceeded") }),
    ).toBe("transport_failure");
  });

  it("message containing 'fetch failed' → transport_failure", () => {
    expect(
      classifyProviderOutcome({ ...baseInput, error: new Error("fetch failed") }),
    ).toBe("transport_failure");
  });

  it("message containing 'Request was aborted' → transport_failure", () => {
    expect(
      classifyProviderOutcome({ ...baseInput, error: new Error("Request was aborted.") }),
    ).toBe("transport_failure");
  });
});

describe("classifyProviderOutcome — rule 3 (unknown_failure)", () => {
  it("HTTP 400 → unknown_failure", () => {
    expect(classifyProviderOutcome({ ...baseInput, error: httpError(400) })).toBe(
      "unknown_failure",
    );
  });

  it("HTTP 401 → unknown_failure", () => {
    expect(classifyProviderOutcome({ ...baseInput, error: httpError(401) })).toBe(
      "unknown_failure",
    );
  });

  it("bare Error with no retryable signal → unknown_failure", () => {
    expect(
      classifyProviderOutcome({ ...baseInput, error: new Error("something broke") }),
    ).toBe("unknown_failure");
  });
});

describe("classifyProviderOutcome — rules 4-5 (no submitReview → quality_failure)", () => {
  it("NVIDIA 4/4 case: iterationsUsed >= maxIterations without submitReview", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: false,
        rating: null,
        iterationsUsed: 4,
        maxIterations: 4,
      }),
    ).toBe("quality_failure");
  });

  it("loop exited early without submitReview (empty-response path)", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: false,
        rating: null,
        iterationsUsed: 2,
        maxIterations: 4,
      }),
    ).toBe("quality_failure");
  });

  it("zero iterations used, no submitReview → quality_failure", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: false,
        rating: null,
        iterationsUsed: 0,
        maxIterations: 4,
      }),
    ).toBe("quality_failure");
  });
});

describe("classifyProviderOutcome — rule 6 (malformed streak)", () => {
  it.each([0, 1, 2])("streak=%d does not fire (below threshold)", (streak) => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: false,
        rating: null,
        malformedStreak: streak,
      }),
    ).toBe("quality_failure"); // falls through to rule 4/5
  });

  it.each([MALFORMED_STREAK_THRESHOLD, MALFORMED_STREAK_THRESHOLD + 1, 10])(
    "streak=%d fires quality_failure even when submitReview was called",
    (streak) => {
      expect(
        classifyProviderOutcome({
          ...baseInput,
          submitReviewCalled: true,
          rating: 8,
          malformedStreak: streak,
        }),
      ).toBe("quality_failure");
    },
  );
});

describe("classifyProviderOutcome — rules 7-8 (reserved for Phase 3)", () => {
  it("refusalDetected → quality_failure even with submitReview + rating", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: true,
        rating: 8,
        refusalDetected: true,
      }),
    ).toBe("quality_failure");
  });

  it("emptyFindings → quality_failure even with submitReview + rating", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: true,
        rating: 8,
        emptyFindings: true,
      }),
    ).toBe("quality_failure");
  });
});

describe("classifyProviderOutcome — rule 9 (success regardless of rating)", () => {
  it.each([1, 3, 4, 6, 8, 10])("rating=%d with submitReview → success", (rating) => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: true,
        rating,
      }),
    ).toBe("success");
  });

  it("rating=4 with valid findings is SUCCESS, not quality_failure (load-bearing test)", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: true,
        rating: 4,
      }),
    ).toBe("success");
  });
});

describe("classifyProviderOutcome — rule 10 (unknown fallback)", () => {
  it("submitReview called but rating=null → unknown_failure", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: true,
        rating: null,
      }),
    ).toBe("unknown_failure");
  });
});

describe("classifyProviderOutcome — rule priority (first match wins)", () => {
  it("interrupted beats malformed streak", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        interrupted: true,
        malformedStreak: 10,
      }),
    ).toBe("interrupted");
  });

  it("transport error beats missing submitReview", () => {
    expect(
      classifyProviderOutcome({
        ...baseInput,
        submitReviewCalled: false,
        rating: null,
        error: httpError(503),
      }),
    ).toBe("transport_failure");
  });

  it("malformed streak beats missing submitReview (both reach quality_failure either way)", () => {
    const outcome = classifyProviderOutcome({
      ...baseInput,
      submitReviewCalled: false,
      rating: null,
      malformedStreak: 5,
    });
    expect(outcome).toBe("quality_failure");
  });
});

describe("isRetryableError", () => {
  it("returns false for null/undefined", () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it("returns true for 429 buried in cause.code", () => {
    const err = new Error("wrapper") as any;
    err.cause = { code: "ECONNRESET" };
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for status buried in response.status", () => {
    const err = new Error("wrapper") as any;
    err.response = { status: 503 };
    expect(isRetryableError(err)).toBe(true);
  });
});
