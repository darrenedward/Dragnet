import { describe, expect, it } from "vitest";
import { formatScanLogText } from "../src/lib/scanLogText";

describe("formatScanLogText", () => {
  it("joins messages one per line", () => {
    expect(
      formatScanLogText([
        { message: "clone ok" },
        { message: "submitReview true" },
      ]),
    ).toBe("clone ok\nsubmitReview true");
  });

  it("includes level and timestamp when present", () => {
    expect(
      formatScanLogText([
        {
          message: "budget exhausted",
          level: "warn",
          createdAt: "2026-08-01T12:00:00.000Z",
        },
      ]),
    ).toBe("2026-08-01T12:00:00.000Z [warn] budget exhausted");
  });

  it("returns empty string for no logs", () => {
    expect(formatScanLogText([])).toBe("");
  });
});
