import { describe, it, expect } from "vitest";

describe("oauthState", () => {
  it("stores and consumes a CSRF token", async () => {
    const mod = await import("../src/lib/oauthState");
    const token = "test-csrf-token-123";
    mod.storeCsrfToken("user-1", token);
    expect(mod.consumeCsrfToken("user-1", token)).toBe(true);
  });

  it("returns false for unknown userId", async () => {
    const mod = await import("../src/lib/oauthState");
    expect(mod.consumeCsrfToken("nonexistent", "token")).toBe(false);
  });

  it("returns false for wrong token", async () => {
    const mod = await import("../src/lib/oauthState");
    mod.storeCsrfToken("user-2", "real-token");
    expect(mod.consumeCsrfToken("user-2", "wrong-token")).toBe(false);
  });

  it("can only consume a token once", async () => {
    const mod = await import("../src/lib/oauthState");
    mod.storeCsrfToken("user-3", "single-use");
    expect(mod.consumeCsrfToken("user-3", "single-use")).toBe(true);
    expect(mod.consumeCsrfToken("user-3", "single-use")).toBe(false);
  });

  it("isolates tokens by userId", async () => {
    const mod = await import("../src/lib/oauthState");
    mod.storeCsrfToken("user-a", "token-a");
    mod.storeCsrfToken("user-b", "token-b");
    // Wrong token for user-a deletes user-a's entry (returns false)
    expect(mod.consumeCsrfToken("user-a", "token-b")).toBe(false);
    // user-b's entry is still intact
    expect(mod.consumeCsrfToken("user-b", "token-a")).toBe(false);
    // user-b's own token works
    expect(mod.consumeCsrfToken("user-b", "token-b")).toBe(true);
  });
});
