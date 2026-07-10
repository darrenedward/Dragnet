import { describe, it, expect } from "vitest";
import { validateSkeptic } from "../src/lib/skepticValidation";
import { DEFAULT_SKEPTIC } from "../src/lib/skepticConfig";

/**
 * Skeptic validation tests — PUT body shape.
 *
 * `validateSkeptic` is the firewall between the API route and the on-disk
 * settings file. It MUST reject anything that isn't a clean SkepticSettings
 * object — partial bodies, wrong types, out-of-range numbers, invalid
 * enums — so client bugs can't corrupt the file.
 */

describe("validateSkeptic — happy path", () => {
  it("accepts a complete body matching the defaults", () => {
    const result = validateSkeptic(DEFAULT_SKEPTIC);
    expect(result).toEqual(DEFAULT_SKEPTIC);
  });

  it("accepts a minimal enabled=false body", () => {
    const result = validateSkeptic({
      enabled: false,
      gateSeverity: ["blocker"],
      gateMinConfidence: 0.7,
      gateCategories: ["Security"],
      skipDeterministic: true,
    });
    expect(result.enabled).toBe(false);
    expect(result.gateSeverity).toEqual(["blocker"]);
  });
});

describe("validateSkeptic — enabled field", () => {
  it("rejects missing enabled", () => {
    expect(() =>
      validateSkeptic({
        gateSeverity: [],
        gateMinConfidence: 0.5,
        gateCategories: [],
        skipDeterministic: true,
      }),
    ).toThrow(/`enabled` must be a boolean/);
  });

  it("rejects non-boolean enabled", () => {
    expect(() => validateSkeptic({ enabled: "true" } as any)).toThrow(
      /`enabled` must be a boolean/,
    );
  });
});

describe("validateSkeptic — gateSeverity", () => {
  it("rejects non-array", () => {
    expect(() => validateSkeptic({ ...DEFAULT_SKEPTIC, gateSeverity: "blocker" } as any)).toThrow(
      /`gateSeverity` must be an array/,
    );
  });

  it("rejects invalid enum value", () => {
    expect(() =>
      validateSkeptic({ ...DEFAULT_SKEPTIC, gateSeverity: ["blocker", "bogus"] }),
    ).toThrow(/invalid entry/);
  });

  it("dedupes while preserving order", () => {
    const result = validateSkeptic({
      ...DEFAULT_SKEPTIC,
      gateSeverity: ["suggestion", "blocker", "suggestion", "warning", "blocker"],
    });
    expect(result.gateSeverity).toEqual(["suggestion", "blocker", "warning"]);
  });

  it("accepts an empty array (effective disable)", () => {
    const result = validateSkeptic({ ...DEFAULT_SKEPTIC, gateSeverity: [] });
    expect(result.gateSeverity).toEqual([]);
  });
});

describe("validateSkeptic — gateMinConfidence", () => {
  it("rejects non-number", () => {
    expect(() =>
      validateSkeptic({ ...DEFAULT_SKEPTIC, gateMinConfidence: "0.5" } as any),
    ).toThrow(/`gateMinConfidence` must be a number/);
  });

  it("rejects NaN", () => {
    expect(() => validateSkeptic({ ...DEFAULT_SKEPTIC, gateMinConfidence: NaN })).toThrow(
      /`gateMinConfidence` must be a number/,
    );
  });

  it("rejects <0", () => {
    expect(() => validateSkeptic({ ...DEFAULT_SKEPTIC, gateMinConfidence: -0.1 })).toThrow(
      /between 0 and 1/,
    );
  });

  it("rejects >1", () => {
    expect(() => validateSkeptic({ ...DEFAULT_SKEPTIC, gateMinConfidence: 1.5 })).toThrow(
      /between 0 and 1/,
    );
  });

  it("accepts 0 and 1 boundaries", () => {
    expect(
      validateSkeptic({ ...DEFAULT_SKEPTIC, gateMinConfidence: 0 }).gateMinConfidence,
    ).toBe(0);
    expect(
      validateSkeptic({ ...DEFAULT_SKEPTIC, gateMinConfidence: 1 }).gateMinConfidence,
    ).toBe(1);
  });
});

describe("validateSkeptic — gateCategories", () => {
  it("rejects non-array", () => {
    expect(() =>
      validateSkeptic({ ...DEFAULT_SKEPTIC, gateCategories: "Security" } as any),
    ).toThrow(/`gateCategories` must be an array/);
  });

  it("rejects empty strings", () => {
    expect(() =>
      validateSkeptic({ ...DEFAULT_SKEPTIC, gateCategories: ["Security", "  "] }),
    ).toThrow(/invalid entry/);
  });

  it("trims whitespace", () => {
    const result = validateSkeptic({
      ...DEFAULT_SKEPTIC,
      gateCategories: ["  Security  ", "Correctness"],
    });
    expect(result.gateCategories).toEqual(["Security", "Correctness"]);
  });
});

describe("validateSkeptic — skipDeterministic", () => {
  it("rejects non-boolean", () => {
    expect(() =>
      validateSkeptic({ ...DEFAULT_SKEPTIC, skipDeterministic: "yes" } as any),
    ).toThrow(/`skipDeterministic` must be a boolean/);
  });
});
