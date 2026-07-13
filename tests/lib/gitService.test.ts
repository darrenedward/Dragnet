import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFetchRefspec,
  buildSyncBranchScript,
} from "../../src/lib/gitService";
import { shellEscape } from "../../src/lib/shellEscape";

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

describe("buildSyncBranchScript", () => {
  // Skip on Windows: script targets /bin/sh + a posix git toolchain.
  const canRunShell = process.platform !== "win32" && process.env.DRAGNET_SKIP_GIT_TESTS !== "1";
  const maybeIt = canRunShell ? it : it.skip;

  // Local file:// remote test fixture: a non-bare repo with two branches
  // pointing at different commits. Returns the tmpdir paths + commit hashes
  // the assertions need. Cleans up itself on test failure via the caller's
  // finally block.
  function setupRemoteRepo(): {
    remoteDir: string;
    mainCommit: string;
    featureCommit: string;
  } {
    const remoteDir = mkdtempSync(join(tmpdir(), "dragnet-remote-"));
    const run = (args: string[]): string =>
      execFileSync("git", ["-C", remoteDir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    run(["init", "-b", "main", remoteDir]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Dragnet Test"]);
    writeFileSync(join(remoteDir, "README.md"), "# main\n");
    run(["add", "README.md"]);
    run(["commit", "-m", "main commit"]);
    const mainCommit = run(["rev-parse", "HEAD"]);
    run(["checkout", "-b", "feature/x"]);
    writeFileSync(join(remoteDir, "README.md"), "# feature\n");
    run(["add", "README.md"]);
    run(["commit", "-m", "feature commit"]);
    const featureCommit = run(["rev-parse", "HEAD"]);
    run(["checkout", "main"]);
    return { remoteDir, mainCommit, featureCommit };
  }

  function runScript(
    script: string,
  ): { exitCode: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: any) {
      return {
        exitCode: typeof err?.status === "number" ? err.status : -1,
        stdout: typeof err?.stdout === "string" ? err.stdout : "",
        stderr: typeof err?.stderr === "string" ? err.stderr : err?.message ?? "",
      };
    }
  }

  maybeIt(
    "succeeds on two consecutive calls against the same workspace (different branches)",
    () => {
      // Reproduces ticket #18: the production failure mode is
      //   fatal: refusing to fetch into branch 'refs/heads/main' checked out at '/workspace'
      // on the SECOND syncToBranch call, because the prior call left the
      // working tree on refs/heads/main and the new fetch's refspec
      // includes '+refs/heads/main:refs/heads/main'.
      //
      // Call sequence mirrors getRealPrs.ts:304 (base branch only) followed
      // by getRealPrs.ts:502 (PR branch + base).
      const { remoteDir, featureCommit } = setupRemoteRepo();
      const workspace = mkdtempSync(join(tmpdir(), "dragnet-ws-"));
      try {
        const url = shellEscape(remoteDir);
        const script1 = buildSyncBranchScript({
          workDir: workspace,
          escapedUrl: url,
          escapedBranch: "main",
          refspecs: buildFetchRefspec(["main"]),
        });
        const result1 = runScript(script1);

        const script2 = buildSyncBranchScript({
          workDir: workspace,
          escapedUrl: url,
          escapedBranch: "feature/x",
          refspecs: buildFetchRefspec(["feature/x", "main"]),
        });
        const result2 = runScript(script2);

        // Both calls must succeed — currently the second one fails with
        // exit 128 and the "refusing to fetch into branch" message.
        expect(result1.exitCode).toBe(0);
        expect(result2.exitCode).toBe(0);

        // After the second call, the workspace HEAD must be at the
        // feature/x commit (proves both fetch + checkout happened).
        const head = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        expect(head).toBe(featureCommit);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(remoteDir, { recursive: true, force: true });
      }
    },
  );

  maybeIt(
    "leaves the working tree detached so a later fetch can update any branch ref",
    () => {
      // Direct assertion for the fix's invariant: after a sync, HEAD must
      // NOT be a symbolic ref to refs/heads/<branch>. If it were, the next
      // syncToBranch whose refspec includes that branch would fail with the
      // same "refusing to fetch" error. Symbolic-ref -q exits 1 with empty
      // output when HEAD is detached.
      const { remoteDir } = setupRemoteRepo();
      const workspace = mkdtempSync(join(tmpdir(), "dragnet-ws-"));
      try {
        const script = buildSyncBranchScript({
          workDir: workspace,
          escapedUrl: shellEscape(remoteDir),
          escapedBranch: "main",
          refspecs: buildFetchRefspec(["main"]),
        });
        const result = runScript(script);
        expect(result.exitCode, result.stderr).toBe(0);

        let symref = "";
        try {
          symref = execFileSync(
            "git",
            ["-C", workspace, "symbolic-ref", "-q", "HEAD"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          ).trim();
        } catch {
          // detached HEAD — desired state
        }
        expect(symref).toBe("");
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(remoteDir, { recursive: true, force: true });
      }
    },
  );
});
