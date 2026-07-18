import { describe, expect, it } from "vitest";
import { isAutoRescanEnabled } from "../src/lib/autoRescanPolicy";

describe("automatic rescan policy", () => {
  it("inherits the global default", () => {
    expect(isAutoRescanEnabled("inherit", { defaultEnabled: false })).toBe(false);
    expect(isAutoRescanEnabled(undefined, { defaultEnabled: true })).toBe(true);
  });

  it("allows an enabled repository to override a disabled global default", () => {
    expect(isAutoRescanEnabled("enabled", { defaultEnabled: false })).toBe(true);
  });

  it("allows a disabled repository to override an enabled global default", () => {
    expect(isAutoRescanEnabled("disabled", { defaultEnabled: true })).toBe(false);
  });
});
