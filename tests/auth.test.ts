import { describe, it, expect } from "vitest";

describe("auth-client module", () => {
  it("can be imported without error", async () => {
    const mod = await import("../src/lib/auth-client");
    expect(mod.authClient).toBeDefined();
  });
});

describe("auth module", () => {
  it("can be imported without error", async () => {
    const mod = await import("../src/lib/auth");
    expect(mod.auth).toBeDefined();
  });
});

describe("api-auth module", () => {
  it("exports getSession and requireSession", async () => {
    const mod = await import("../src/lib/api-auth");
    expect(typeof mod.getSession).toBe("function");
    expect(typeof mod.requireSession).toBe("function");
  });
});
