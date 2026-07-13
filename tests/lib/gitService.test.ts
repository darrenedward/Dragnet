import { describe, it, expect } from "vitest";
import { buildFetchRefspec } from "../../src/lib/gitService";

describe("buildFetchRefspec", () => {
  it("builds a single-quote-wrapped refspec for one branch", () => {
    expect(buildFetchRefspec(["main"])).toBe(
      "'+refs/heads/main:refs/heads/main'",
    );
  });

  it("joins multiple single-quote-wrapped refspecs with spaces", () => {
    expect(buildFetchRefspec(["main", "feature/auth"])).toBe(
      "'+refs/heads/main:refs/heads/main' '+refs/heads/feature/auth:refs/heads/feature/auth'",
    );
  });

  it("passes branch names with hyphens, dots, and underscores through verbatim", () => {
    expect(buildFetchRefspec(["release/v1.2.3_rc"])).toBe(
      "'+refs/heads/release/v1.2.3_rc:refs/heads/release/v1.2.3_rc'",
    );
  });

  it("returns an empty string for an empty input", () => {
    expect(buildFetchRefspec([])).toBe("");
  });

  it("escapes embedded single-quotes so the outer wrap stays intact", () => {
    // Branch name "my'branch" must round-trip through the shell. The naive
    // wrap would produce "+refs/heads/my'branch:refs/heads/my'branch"
    // which terminates the outer quote at the first '. The accepted
    // form closes/reopens the quoted span around the literal '.
    expect(buildFetchRefspec(["my'branch"])).toBe(
      "'+refs/heads/my'\\''branch:refs/heads/my'\\''branch'",
    );
  });

  it("escapes every embedded single-quote (multiple occurrences)", () => {
    expect(buildFetchRefspec(["a'b'c"])).toBe(
      "'+refs/heads/a'\\''b'\\''c:refs/heads/a'\\''b'\\''c'",
    );
  });

  it("escapes branch names with shell metacharacters together with the quote", () => {
    // '$' is normally fine inside single quotes, but the embedded '
    // forces the close/reopen pattern; both must coexist.
    expect(buildFetchRefspec(["weird'$branch"])).toBe(
      "'+refs/heads/weird'\\''$branch:refs/heads/weird'\\''$branch'",
    );
  });

  it("escapes leading and trailing single-quotes as well", () => {
    expect(buildFetchRefspec(["'lead", "tail'"])).toBe(
      "'+refs/heads/'\\''lead:refs/heads/'\\''lead' '+refs/heads/tail'\\'':refs/heads/tail'\\'''",
    );
  });

  it("leaves names with no embedded single-quote byte-identical to the legacy output", () => {
    // Regression: ensure the escape path does not perturb the common case.
    expect(buildFetchRefspec(["main", "feature/auth", "release/v1.2.3_rc"])).toBe(
      "'+refs/heads/main:refs/heads/main' '+refs/heads/feature/auth:refs/heads/feature/auth' '+refs/heads/release/v1.2.3_rc:refs/heads/release/v1.2.3_rc'",
    );
  });

  it("round-trips a quoted branch name through /bin/sh", () => {
    // End-to-end acceptance: bake buildFetchRefspec's output into a real
    // shell script the way the production syncScript does (gitService.ts:228),
    // run it through /bin/sh, and verify the shell parses the refspec back
    // to the original branch name. The previous version of this test passed
    // the refspec via argv (`sh -c ... "_" "$refspec"`); argv expansion in
    // node already unquotes the value, so sh never sees the single-quoted
    // form and the test passed for any string — including the unescaped
    // naive form which actually corrupts the branch name in real shells.
    //
    // To make the test meaningful, write the refspec INTO the script body
    // (the way gitService.ts:228 interpolates it into a multi-statement
    // bash string) so sh parses the single-quoted form. If escape
    // regresses, the naive form would parse `my'branch` as the literal
    // `mybranch` (the ' chars stripped), and this test fails immediately.
    if (process.platform === "win32") return;
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const { writeFileSync, mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const branches = ["my'branch", "a'b'c", "weird'$branch", "'lead", "tail'"];
    for (const branch of branches) {
      const refspec = buildFetchRefspec([branch]);
      // Write a one-line script that printf's the (single-quoted) refspec,
      // then run it with /bin/sh. shell parses it, removes the surrounding
      // single quotes, and prints the canonical git refspec token. This
      // mirrors the real syncScript's `git fetch origin … ${refspec}`
      // shape — same parse order, same shell-context boundaries.
      const dir = mkdtempSync(join(tmpdir(), "dragnet-rt-"));
      const script = join(dir, "rt.sh");
      writeFileSync(script, `printf '%s\\n' ${refspec}\n`);
      let parsed: string;
      try {
        parsed = execFileSync("/bin/sh", [script], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trimEnd();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // The shell un-quotes the refspec and emits the canonical token
      // git would receive. The branch name must round-trip byte-for-byte
      // (including any literal $, ', ;, backticks, etc.).
      expect(parsed).toBe(`+refs/heads/${branch}:refs/heads/${branch}`);
    }
  });
});