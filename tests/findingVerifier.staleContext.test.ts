import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReviewTree } from "../src/lib/reviewTree";
import { verifyFindings, type CandidateFinding } from "../src/services/findingVerifier";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Host checkout stays on main; tip branch has different file bodies.
 * Verifier must prefer tip tree so stale main-only citations are rejected
 * and real tip citations still pass.
 */
function initTipRepo(): {
  root: string;
  tipSha: string;
  baseSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dragnet-stale-ctx-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "test@dragnet.local"]);
  git(root, ["config", "user.name", "Test"]);

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "auth.ts"),
    [
      "export function oldHelper() {",
      "  return 'main-only-body';",
      "}",
      "",
      "export function requireSession() {",
      "  return true;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "src", "only-main.ts"), "export const only = 'main';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "main base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "-q", "-b", "feature/tip"]);
  // Tip rewrites auth.ts: removes oldHelper, adds tipBug, keeps requireSession.
  writeFileSync(
    join(root, "src", "auth.ts"),
    [
      "export function tipBug(req: Request) {",
      "  // missing auth on tip",
      "  return { data: 'exposed' };",
      "}",
      "",
      "export function requireSession() {",
      "  return true;",
      "}",
      "",
      "export function newOnTip() {",
      "  return 'tip-only-symbol';",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "src", "new-on-tip.ts"), "export const neu = 'tip-only';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "tip changes"]);
  const tipSha = git(root, ["rev-parse", "HEAD"]);

  // Leave ambient checkout on main.
  git(root, ["checkout", "-q", "main"]);
  expect(readFileSync(join(root, "src", "auth.ts"), "utf8")).toContain("main-only-body");
  expect(readFileSync(join(root, "src", "auth.ts"), "utf8")).not.toContain("tipBug");

  return { root, tipSha, baseSha };
}

function finding(opts: Partial<CandidateFinding> & { id: string }): CandidateFinding {
  return {
    category: "Performance",
    severity: "warning",
    filename: "src/auth.ts",
    line: 1,
    explanation: "issue",
    ...opts,
  };
}

describe("findingVerifier tip-first + stale_context", () => {
  let root: string;
  let tipSha: string;
  let baseSha: string;

  beforeEach(() => {
    const r = initTipRepo();
    root = r.root;
    tipSha = r.tipSha;
    baseSha = r.baseSha;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects stale citation (main-only symbol / absent on tip) with stale_context note", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });

    // oldHelper exists only on main ambient disk, not on tip.
    // Keep explanation free of prose tokens that appear on tip (e.g. "only").
    const results = await verifyFindings(
      [
        finding({
          id: "stale-1",
          line: 1,
          explanation: "`oldHelper` is broken",
        }),
      ],
      root,
      "test-pr",
      { reviewTree: tree },
    );

    const v = results.get("stale-1");
    expect(v?.status).toBe("rejected");
    expect(v?.note).toMatch(/stale_context/i);
    expect(v?.note).toMatch(/oldHelper/);
  });

  it("rejects citation of a line outside tip file bounds with stale_context", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });

    const tipContent = await tree.readFile("src/auth.ts");
    const tipLines = (tipContent ?? "").split("\n").length;

    const results = await verifyFindings(
      [
        finding({
          id: "stale-oob",
          line: tipLines + 50,
          explanation: "`requireSession` issue past end of tip file",
        }),
      ],
      root,
      "test-pr",
      { reviewTree: tree },
    );

    const v = results.get("stale-oob");
    expect(v?.status).toBe("rejected");
    expect(v?.note).toMatch(/stale_context/i);
    expect(v?.note).toMatch(/outside/i);
  });

  it("rejects citation of a file absent on tip with stale_context", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });

    // only-main.ts exists on ambient main checkout but was never on tip branch
    // wait — only-main.ts was committed on main before branch, so it IS on tip.
    // Use a path that never existed on tip: invent a fake path that ambient
    // also lacks, OR delete-only-on-tip. Tip deleted nothing. Create ambient-only
    // by writing after checkout main without committing — ambient disk has it,
    // tip git-show does not.
    writeFileSync(
      join(root, "src", "ambient-only.ts"),
      "export const ambientMarker = 1;\n",
    );

    const results = await verifyFindings(
      [
        finding({
          id: "stale-file",
          filename: "src/ambient-only.ts",
          line: 1,
          explanation: "`ambientMarker` is exposed",
        }),
      ],
      root,
      "test-pr",
      { reviewTree: tree },
    );

    const v = results.get("stale-file");
    expect(v?.status).toBe("rejected");
    expect(v?.note).toMatch(/stale_context/i);
    expect(v?.note).toMatch(/does not exist on tip/);
    // Without tip tree, ambient would have found the file.
    const ambient = await verifyFindings(
      [
        finding({
          id: "ambient-ok",
          filename: "src/ambient-only.ts",
          line: 1,
          explanation: "`ambientMarker` is exposed",
        }),
      ],
      root,
      "test-pr",
    );
    expect(ambient.get("ambient-ok")?.status).toBe("verified");
  });

  it("accepts tip citation when evidence holds (real tip bug)", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });

    // tipBug exists only on tip — ambient main does not have it.
    const results = await verifyFindings(
      [
        finding({
          id: "tip-bug",
          line: 1,
          explanation: "`tipBug` returns data without authentication",
        }),
      ],
      root,
      "test-pr",
      { reviewTree: tree },
    );

    const v = results.get("tip-bug");
    expect(v?.status).toBe("verified");
    expect(v?.note).not.toMatch(/stale_context/i);

    // Ambient-only path would reject (symbol missing on main disk).
    const ambient = await verifyFindings(
      [
        finding({
          id: "ambient-miss",
          line: 1,
          explanation: "`tipBug` returns data without authentication",
        }),
      ],
      root,
      "test-pr",
    );
    expect(ambient.get("ambient-miss")?.status).toBe("rejected");
  });

  it("absence claim uses tip existence (file only on tip contradicts absence)", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });

    // new-on-tip.ts exists on tip only; ambient main lacks it.
    // Prose requireSession (no backticks) satisfies Stage A without becoming
    // an absence symbol candidate (only quoted paths/symbols are).
    const expl =
      'The file "src/new-on-tip.ts" does not exist near requireSession';
    const results = await verifyFindings(
      [
        finding({
          id: "abs-tip",
          filename: "src/auth.ts",
          line: 6,
          explanation: expl,
        }),
      ],
      root,
      "test-pr",
      { reviewTree: tree },
    );

    const v = results.get("abs-tip");
    expect(v?.status).toBe("rejected");
    expect(v?.note).toMatch(/absence_claim_contradicted/);

    // Ambient path would not see the tip-only file → would verify absence.
    const ambient = await verifyFindings(
      [
        finding({
          id: "abs-ambient",
          filename: "src/auth.ts",
          line: 5,
          explanation: expl,
        }),
      ],
      root,
      "test-pr",
    );
    // Ambient: requireSession on main; absence of tip-only file is "true" on main.
    expect(ambient.get("abs-ambient")?.status).toBe("verified");
    expect(ambient.get("abs-ambient")?.note).toMatch(/absence claim verified/i);
  });
});
