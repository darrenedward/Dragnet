import { describe, expect, it } from "vitest";

import { buildReviewMarkdown, sanitizeBranchSlug } from "../src/lib/exportReviewMarkdown";

describe("sanitizeBranchSlug", () => {
  it("lowercases and converts slashes to dashes", () => {
    expect(sanitizeBranchSlug("feat/skills-bulk")).toBe("feat-skills-bulk");
  });

  it("strips characters outside [a-z0-9-_]", () => {
    // lowercase → feat_foo!bar, then strip ! → feat_foobar
    expect(sanitizeBranchSlug("FEAT_Foo!Bar")).toBe("feat_foobar");
    // lowercase → user/feat--x.y, slash → dash, dot stripped (no replacement)
    expect(sanitizeBranchSlug("user/feat--x.y")).toBe("user-feat--xy");
  });

  it("strips leading/trailing dashes", () => {
    expect(sanitizeBranchSlug("---weird---")).toBe("weird");
  });

  it("preserves internal double-dashes and underscores", () => {
    expect(sanitizeBranchSlug("fix__bug--v2")).toBe("fix__bug--v2");
  });

  it("returns empty string for purely-symbolic input", () => {
    expect(sanitizeBranchSlug("@#$%^&*()")).toBe("");
  });
});

describe("buildReviewMarkdown", () => {
  const baseInput = {
    repoName: "Dragnet",
    prTitle: "Add chunker rewrite",
    prNumber: 42,
    sourceBranch: "feat/chunker",
    targetBranch: "main",
    commitHash: "abc1234",
    author: "Darren",
    runId: "run-620721d3-ce15-4031-86ec-fac532097f78",
    scannedAt: new Date("2026-06-29T12:00:00Z"),
    files: [
      { filename: "src/a.ts", additions: 100, deletions: 10 },
      { filename: "src/b.ts", additions: 50, deletions: 0 },
    ],
    findings: [
      {
        severity: "high",
        category: "Security",
        filename: "src/a.ts",
        line: 42,
        explanation: "SQL injection.",
        diffSuggestion: "const safe = db.escape(input);",
      },
    ],
  };

  it("emits System Details block with all metadata", () => {
    const md = buildReviewMarkdown(baseInput);
    expect(md).toContain("**Project:** `Dragnet`");
    expect(md).toContain("**Pull Request:** `Add chunker rewrite` (#42)");
    expect(md).toContain("**Source Branch:** `feat/chunker` `(abc1234)`");
    expect(md).toContain("**Target/Base Branch:** `main`");
    expect(md).toContain("**Author Name:** `Darren`");
    expect(md).toContain("**Scanned On (UTC):** `2026-06-29T12:00:00.000Z`");
    expect(md).toContain("**Review Run ID:** `run-620721d3");
  });

  it("lists every file with additions + deletions", () => {
    const md = buildReviewMarkdown(baseInput);
    expect(md).toContain("`src/a.ts` (`+100` additions, `-10` deletions)");
    expect(md).toContain("`src/b.ts` (`+50` additions, `-0` deletions)");
  });

  it("numbers findings and uppercases severity", () => {
    const md = buildReviewMarkdown(baseInput);
    expect(md).toContain("### [1] Severity: **HIGH** • Category: **Security**");
    expect(md).toContain("**Location:** `src/a.ts` (Line 42)");
    expect(md).toContain("**Observation Detail:** SQL injection.");
    expect(md).toContain("```rust\nconst safe = db.escape(input);\n```");
  });

  it("celebrates clean PRs", () => {
    const md = buildReviewMarkdown({ ...baseInput, findings: [] });
    expect(md).toContain("Perfect PR Pass!");
  });

  it("omits optional fields when not provided", () => {
    const md = buildReviewMarkdown({
      repoName: "R",
      prTitle: "T",
      sourceBranch: "b",
      targetBranch: "main",
      files: [],
      findings: [],
    });
    expect(md).not.toContain("Author Name");
    expect(md).not.toContain("Review Run ID");
    // PR title is required; prNumber is the optional bit.
    expect(md).toContain("**Pull Request:** `T`");
    expect(md).not.toContain("(#");
  });
});
