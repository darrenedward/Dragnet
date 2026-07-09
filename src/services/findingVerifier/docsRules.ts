/**
 * Documentation-file detection rules for the finding verifier.
 *
 * Findings citing these extensions/paths are auto-rejected in normal code
 * review mode — docs are context for understanding intent, not bug
 * locations. Extracted from `findingVerifier.ts` so the same rules are
 * reachable from the skeptic pass and absence-claim paths without
 * dragging in the parent's Prisma/LLM machinery.
 */

import path from "node:path";

const DOCS_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
  ".asciidoc",
  ".org",
]);

const DOCS_PATH_PATTERNS = [
  /^\.agent-os\//i,
  /^docs?\//i,
  /^documentation\//i,
  /(^|\/)CHANGELOG/i,
  /(^|\/)CONTRIBUTING/i,
  /(^|\/)LICENSE/i,
  /(^|\/)README/i,
  /(^|\/)AUTHORS/i,
];

export function isDocumentationFile(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/").replace(/^\.\//, "");
  const ext = path.extname(normalized).toLowerCase();
  if (DOCS_EXTENSIONS.has(ext)) return true;
  return DOCS_PATH_PATTERNS.some((p) => p.test(normalized));
}
