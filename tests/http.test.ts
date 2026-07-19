import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/lib/http";

describe("fetchJson authentication handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects a same-origin 401 to login with the current callback", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:3300",
        pathname: "/prs",
        search: "?repo=dragnet",
        assign,
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await fetchJson("/api/prs");

    expect(assign).toHaveBeenCalledWith(
      "/login?callbackURL=%2Fprs%3Frepo%3Ddragnet",
    );
  });
});
