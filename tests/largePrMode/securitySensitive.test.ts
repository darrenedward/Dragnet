import { describe, expect, it } from "vitest";
import { isSecuritySensitive, matchGlob } from "../../src/services/largePrReview";

describe("largePrReview securitySensitive", () => {
  it("matches global defaults", () => {
    expect(isSecuritySensitive("src/app/api/auth/login/route.ts")).toBe(true);
    expect(isSecuritySensitive("src/lib/pathSafety.ts")).toBe(true);
    expect(isSecuritySensitive("prisma/schema.prisma")).toBe(true);
  });

  it("matches keyword fallback paths", () => {
    expect(isSecuritySensitive("src/components/session-provider.tsx")).toBe(true);
    expect(isSecuritySensitive("src/lib/webhookSetup.ts")).toBe(true);
  });

  it("matches repo-configured globs", () => {
    expect(isSecuritySensitive("src/payments/checkout.ts", ["src/payments/**"])).toBe(true);
    expect(isSecuritySensitive("src/catalog/list.ts", ["src/payments/**"])).toBe(false);
  });

  it("supports simple glob forms", () => {
    expect(matchGlob("src/a/b.ts", "src/**")).toBe(true);
    expect(matchGlob("src/a/b.ts", "src/*/b.ts")).toBe(true);
    expect(matchGlob("src/a/c.ts", "src/*/b.ts")).toBe(false);
  });
});
