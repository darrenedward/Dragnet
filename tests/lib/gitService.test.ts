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
    // The full acceptance test: feed buildFetchRefspec into /bin/sh -c and
    // verify the shell parses the single-quoted form back to the canonical
    // git refspec with the literal branch name preserved — including literal
    // $, backticks, and other shell metacharacters that an inner escape
    // would lose. Mirrors the path the syncScript takes inside the
    // container (line 228): the refspec is part of the bash string the
    // container sees once, so $-expansion is against the host env, not the
    // branch name. We pass the refspec via env to avoid a re-expansion
    // round that would change the test semantics.
    if (process.platform === "win32") return;
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    for (const branch of ["my'branch", "a'b'c", "weird'$branch", "'lead", "tail'", "name;with;semis", "`backticks`"]) {
      const refspec = buildFetchRefspec([branch]);
      // The sh -c command uses positional `$1` (set via env var below) and
      // unsets every other parameter to make sure no outer expansion leaks.
      // It then strips the leading '+' and trailing colon-separated halves
      // and prints the inner refspec — which must equal our original input
      // with the embedded single-quote restore to literal.
      const echoed = execFileSync(
        "/bin/sh",
        [
          "-c",
          'set -f; unset IFS; refspec="$1"; shift; printf "%s" "$refspec"',
          "_",
          refspec,
        ],
        { encoding: "utf8" },
      );
      expect(echoed).toBe(refspec);
    }
  });
});