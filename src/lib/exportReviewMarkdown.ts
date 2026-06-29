/**
 * Build the markdown summary card for a completed review run.
 *
 * Used by both the new `POST /api/prs/[prId]/runs/[runId]/export-markdown`
 * route (writes to `.dragnet/reviews/<prSlug>/<runId>.md`) and the
 * legacy client-side blob-download path. Keeping the builder in one
 * place means the two outputs stay byte-identical.
 */

export interface ExportFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface ExportFinding {
  severity: string;
  category: string;
  filename: string;
  line: number | string;
  explanation: string;
  diffSuggestion?: string | null;
}

export interface ExportReviewInput {
  repoName: string;
  prTitle: string;
  prNumber?: number | null;
  sourceBranch: string;
  targetBranch: string;
  commitHash?: string | null;
  author?: string;
  runId?: string;
  scannedAt?: Date;
  files: ExportFile[];
  findings: ExportFinding[];
}

export function buildReviewMarkdown(input: ExportReviewInput): string {
  const {
    repoName,
    prTitle,
    prNumber,
    sourceBranch,
    targetBranch,
    commitHash,
    author,
    runId,
    scannedAt,
    files,
    findings,
  } = input;

  let md = `# Dragnet automated PR Code Review Summary Card\n\n`;
  md += `### System Details:\n`;
  md += `- **Project:** \`${repoName}\`\n`;
  md += `- **Pull Request:** \`${prTitle}\`${prNumber ? ` (#${prNumber})` : ""}\n`;
  md += `- **Source Branch:** \`${sourceBranch}\`${commitHash ? ` \`(${commitHash})\`` : ""}\n`;
  md += `- **Target/Base Branch:** \`${targetBranch}\`\n`;
  if (author) md += `- **Author Name:** \`${author}\`\n`;
  md += `- **Scanned On (UTC):** \`${(scannedAt ?? new Date()).toISOString()}\`\n`;
  if (runId) md += `- **Review Run ID:** \`${runId}\`\n`;
  md += `- **Core Policy Stack:** Compliance Dragnet Guard v4\n\n`;
  md += `--- \n\n`;

  md += `## Files Checked in Pull Request:\n`;
  for (const file of files) {
    md += `- **File:** \`${file.filename}\` (\`+${file.additions}\` additions, \`-${file.deletions}\` deletions)\n`;
  }
  md += `\n`;

  md += `## Review Findings and Severity Alerts:\n\n`;
  if (findings.length === 0) {
    md += `🎉 **Perfect PR Pass!** No bugs, performance leaks, or security vulnerabilities discovered for this diff block.\n`;
  } else {
    findings.forEach((find, idx) => {
      md += `### [${idx + 1}] Severity: **${find.severity.toUpperCase()}** • Category: **${find.category}**\n`;
      md += `- **Location:** \`${find.filename}\` (Line ${find.line})\n`;
      md += `- **Observation Detail:** ${find.explanation}\n`;
      if (find.diffSuggestion) {
        md += `\n**Proposed Resolution:**\n`;
        md += `\`\`\`rust\n${find.diffSuggestion}\n\`\`\`\n`;
      }
      md += `\n---\n\n`;
    });
  }

  md += `\n\n_Auto compiled by Dragnet daemon - Local-First PR review agent._`;
  return md;
}

/**
 * Slugify a branch name for use as a directory: lowercase, `/` → `-`,
 * strip anything outside `[a-z0-9-_]`. Examples:
 *   feat/skills-bulk      → feat-skills-bulk
 *   FEAT_Foo!Bar          → feat-foo-bar
 *   user/feat--x.y        → user-feat--x-y
 */
export function sanitizeBranchSlug(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/^-+|-+$/g, "");
}
