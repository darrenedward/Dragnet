/**
 * Explanation-text parsing + Stage A.5 absence-claim verifier.
 *
 * Two concerns live here:
 *
 *   1. `extractCitedSymbols` — used by Stage A (line/file validation in
 *      the parent file) to confirm that the symbols referenced in the
 *      finding's explanation actually appear in the cited code window.
 *      Pure regex extraction, no I/O.
 *
 *   2. Stage A.5 `checkAbsenceClaim` — catches the failure mode where
 *      the LLM reviewer claims a file/route/import does not exist or is
 *      unused, but the filesystem contradicts the claim. Cheap and
 *      deterministic — no LLM call.
 *
 * Triggered from verifyOne() between Stage A (line/file validation) and
 * Stage B (counter-evidence retrieval). Returns null when no absence
 * phrase matched (caller falls through to Stage B). Returns a verdict
 * only when the explanation made an absence claim AND we have positive
 * evidence one way or the other.
 *
 * Conservative by construction: only reject when we have *positive*
 * evidence the claim is wrong. "I couldn't decide" falls through — the
 * Stage B LLM pass or the human reviewer can still catch it.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveSafePath } from "@/src/lib/pathSafety";
import type { CandidateFinding, VerificationResult } from "../findingVerifier";

// ─── Explanation-text extraction (also used by Stage A) ───────────────

/**
 * Pull identifier-like tokens out of a finding's explanation. Used by
 * Stage A's substring check: does the cited code window actually
 * contain the symbols the explanation talks about?
 *
 * Backtick-quoted identifiers are highest signal. Bare camelCase /
 * PascalCase identifiers from prose are the fallback. Deduped, English-
 * word-filtered, capped at 5.
 */
export function extractCitedSymbols(explanation: string): string[] {
  const tickMatch = explanation.match(/`([A-Za-z_][A-Za-z0-9_.#[\]/-]{1,80})`/g);
  const ticked = tickMatch?.map((m) => m.replace(/`/g, "")) ?? [];

  const proseMatch = explanation.match(/\b(?:[a-z][a-zA-Z0-9_]{3,}|[A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g);
  const fromProse = proseMatch ?? [];

  const STOP = new Set(["the", "this", "that", "with", "from", "into", "true", "false", "null"]);
  const all = [...new Set([...ticked, ...fromProse])].filter((s) => !STOP.has(s.toLowerCase()));

  return all.slice(0, 5);
}

/**
 * Phrases that signal an absence claim in the finding's explanation.
 * Matched case-insensitively as substrings.
 *
 * Grows over time as new false-positive patterns surface. Keep the list
 * specific — generic phrases like "missing" or "no" alone are too broad
 * and would over-trigger.
 */
const ABSENCE_PHRASES: readonly string[] = [
  "does not exist",
  "doesn't exist",
  "is not defined",
  "isn't defined",
  "not defined",
  "never declared",
  "no definition of",
  "is undefined",
  "missing file",
  "missing route",
  "missing handler",
  "missing endpoint",
  "no such file",
  "no route",
  "no handler",
  "no endpoint",
  "not found",
  "absent",
  "unused import",
  "import is unused",
  "imported but never used",
  "imported but not used",
  "never imported",
  "not imported",
  "not used anywhere",
  "never used",
  "is unused",
];

/**
 * Match an absence phrase in the explanation. Returns the matched
 * phrase (lowercased) or null.
 */
export function matchAbsencePhrase(explanation: string): string | null {
  const lower = explanation.toLowerCase();
  for (const phrase of ABSENCE_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Extract candidate identifiers from a finding's explanation. Returns
 * 0–N candidates, each classified as a path or a symbol.
 *
 * Heuristics, in priority order:
 *   1. Quoted paths: `"src/app/api/skills/import-pack/route.ts"`
 *   2. Quoted symbols: `` `js-yaml` ``, `'load'``
 *   3. Bare path-shaped tokens: `src/lib/foo.ts`, `app/api/bar/route.ts`
 *   4. URL-shaped tokens: `/api/skills/import-pack` → check Next.js route
 *      file at `src/app/api/skills/import-pack/route.ts`
 *   5. Bare identifiers following keywords: `import X`, `function Y`
 *
 * English words and generic code nouns (handler, endpoint, file, route,
 * function, etc.) are filtered out — they're too generic to give
 * meaningful counter-evidence and cause false-rejection of correct
 * absence claims.
 *
 * Caps at 6 candidates per finding to bound the work.
 */
export function extractAbsenceCandidates(
  explanation: string,
): Array<{ kind: "path" | "symbol"; value: string }> {
  const out: Array<{ kind: "path" | "symbol"; value: string }> = [];
  const seen = new Set<string>();

  const push = (kind: "path" | "symbol", raw: string) => {
    const value = raw.trim().replace(/^['"`]|['"`]$/g, "");
    if (!value || value.length < 2 || value.length > 200) return;
    if (seen.has(value)) return;
    // Skip generic English words / code nouns that would match too widely.
    if (ENGLISH_OR_GENERIC.has(value.toLowerCase())) return;
    seen.add(value);
    out.push({ kind, value });
  };

  // 1+2) Quoted strings — most often file paths or package names.
  const quoted = explanation.matchAll(/["'`]([^"'`\n]{2,200})["'`]/g);
  for (const m of quoted) {
    const v = m[1];
    if (looksLikePath(v)) push("path", v);
    else push("symbol", v);
  }

  // 3) Bare path-shaped tokens. e.g. `src/lib/foo.ts` in prose.
  const barePaths = explanation.matchAll(
    /\b((?:src|app|pages|lib|api|components|services)\/[A-Za-z0-9_./-]+\.[a-z]{2,5})\b/g,
  );
  for (const m of barePaths) push("path", m[1]);

  // 4) URL-shaped tokens (API paths, REST routes). e.g. `/api/foo/bar`.
  // These almost always correspond to a Next.js route handler file at
  // `src/app<url>/route.ts` — checked by pathExists with the converted path.
  const urls = explanation.matchAll(/(^|[^a-zA-Z0-9])(\/(?:api|repos|hooks|webhooks)\/[a-z0-9][a-z0-9/_-]*[a-z0-9])/g);
  for (const m of urls) {
    push("path", m[2]);
  }

  // 5) Bare identifiers following absence keywords. e.g. "import js-yaml
  // is unused", "function foo is not defined". Require identifier shape
  // (camelCase / kebab-case / dotted) — filters "the", "this", etc.
  const keywordIdent = explanation.matchAll(
    /\b(?:import|imports|from|package|symbol)\s+([A-Za-z_][A-Za-z0-9_@./-]{1,80})\b/g,
  );
  for (const m of keywordIdent) {
    const v = m[1];
    if (looksLikePath(v)) push("path", v);
    else if (isIdentifierShaped(v)) push("symbol", v);
  }

  return out.slice(0, 6);
}

const ENGLISH_OR_GENERIC = new Set([
  // English stopwords
  "the", "this", "that", "these", "those", "with", "from", "into",
  "for", "and", "but", "or", "not", "yes", "no",
  "true", "false", "null", "undefined",
  // Generic code nouns — would match in nearly every codebase
  "function", "method", "handler", "endpoint", "route", "file", "import",
  "const", "let", "var", "class", "object", "array", "string", "number",
  "module", "package", "api", "app", "page", "component", "service",
  "missing", "unused", "absent", "post", "get", "put", "delete", "patch",
]);

function isIdentifierShaped(s: string): boolean {
  // camelCase, PascalCase, kebab-case, snake_case, dotted.package, or
  // contains a digit — all signal a real identifier vs an English word.
  return /[a-z][A-Z]/.test(s) // camelCase
    || /^[A-Z][a-z]+(?:[A-Z][a-z]+)+/.test(s) // PascalCase
    || /[_-]/.test(s) // snake / kebab
    || /\./.test(s) // dotted
    || /\d/.test(s); // contains digit
}

function looksLikePath(value: string): boolean {
  // Has a file extension, or contains a slash — treat as a path.
  return /\.[a-z]{2,5}$/i.test(value) || value.includes("/");
}

/**
 * Check if a candidate path exists, trying multiple base directories.
 * Returns the resolved path that exists, or null.
 *
 * For URL-shaped candidates (`/api/skills/import-pack`), tries Next.js
 * App Router conventions: `src/app<url>/route.ts`, `app<url>/route.ts`.
 */
export function pathExists(repoPath: string, candidate: string): string | null {
  // URL → route file conversion. /api/foo/bar → src/app/api/foo/bar/route.ts
  if (/^\/(?:api|repos|hooks|webhooks)\//.test(candidate)) {
    const bases = ["src/app", "app", "src/pages/api", "pages/api"];
    const exts = ["route.ts", "route.tsx", "handler.ts", "index.ts"];
    for (const base of bases) {
      for (const ext of exts) {
        const rel = `${base}${candidate}/${ext}`;
        const resolved = resolveSafePath(repoPath, rel);
        if (resolved && fs.existsSync(resolved)) return resolved;
      }
    }
    return null;
  }

  // Try as-is first.
  const direct = resolveSafePath(repoPath, candidate);
  if (direct && fs.existsSync(direct)) return direct;

  // Try common roots if the candidate is a bare filename.
  const prefixes = ["src/", "app/", "pages/", ""];
  for (const prefix of prefixes) {
    const resolved = resolveSafePath(repoPath, prefix + candidate);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }

  return null;
}

/**
 * Check if a symbol/package is referenced anywhere in the repo's source.
 * Uses grep under the hood; times out after 5s on huge repos.
 *
 * Returns the first matching `file:line` string (repo-relative), or null.
 */
export function symbolIsUsed(repoPath: string, candidate: string): string | null {
  if (!isSearchableSymbol(candidate)) return null;

  // Escape regex metacharacters so the candidate is matched literally.
  const pattern = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const args = [
    "-r", "-n",
    "--include=*.ts",
    "--include=*.tsx",
    "--include=*.js",
    "--include=*.jsx",
    "--include=*.mjs",
    "--include=*.cjs",
    "--exclude-dir=node_modules",
    "--exclude-dir=.next",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "-I", // skip binary files
    "--",
    pattern,
    ".",
  ];

  try {
    const result = execFileSyncSafe("grep", args, repoPath, 5000);
    if (!result) return null;
    // Output is `./relative/path:line:content` — strip the leading `./`.
    const firstLine = result.split("\n")[0] || "";
    const cleaned = firstLine.replace(/^\.\//, "");
    return cleaned.split(":").slice(0, 2).join(":") || null;
  } catch {
    return null;
  }
}

function isSearchableSymbol(s: string): boolean {
  if (s.length < 2 || s.length > 80) return false;
  // Filter out English words that would match too widely.
  const STOP = new Set([
    "the", "this", "that", "with", "from", "into",
    "true", "false", "null", "undefined", "function",
    "import", "const", "let", "var", "file", "route",
    "missing", "unused",
  ]);
  if (STOP.has(s.toLowerCase())) return false;
  // Must contain at least one identifier-ish character.
  return /[A-Za-z0-9_-]/.test(s);
}

/**
 * Synchronous-execFile wrapper with timeout. Returns stdout on success
 * (exit 0), empty string on no matches (exit 1), and throws on any
 * other failure (binary file, permission error, timeout).
 */
function execFileSyncSafe(cmd: string, args: string[], cwd: string, timeoutMs: number): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).toString("utf-8");
  } catch (err: any) {
    // grep exit code 1 = "no matches found" — not an error.
    if (err?.status === 1) return "";
    throw err;
  }
}

/**
 * Stage A.5 entry point. Returns:
 *   - null if no absence phrase matched (fall through to Stage B)
 *   - { status: "verified" } if claim is correct (candidates all genuinely absent)
 *   - { status: "rejected", note } if filesystem contradicts the claim
 */
export function checkAbsenceClaim(
  finding: CandidateFinding,
  repoPath: string,
): VerificationResult | null {
  const phrase = matchAbsencePhrase(finding.explanation || "");
  if (!phrase) return null;

  const candidates = extractAbsenceCandidates(finding.explanation || "");
  if (candidates.length === 0) {
    // Absence claim made but no specific identifier cited — can't
    // verify. Fall through to Stage B.
    return null;
  }

  for (const candidate of candidates) {
    if (candidate.kind === "path") {
      const exists = pathExists(repoPath, candidate.value);
      if (exists) {
        return {
          status: "rejected",
          note: `absence_claim_contradicted_by_fs: phrase "${phrase}" but path "${candidate.value}" exists at ${path.relative(repoPath, exists)}`,
        };
      }
    } else {
      const usedAt = symbolIsUsed(repoPath, candidate.value);
      if (usedAt) {
        return {
          status: "rejected",
          note: `absence_claim_contradicted_by_fs: phrase "${phrase}" but symbol "${candidate.value}" is referenced at ${usedAt}`,
        };
      }
    }
  }

  // Every cited candidate genuinely does not exist / is not used.
  // The absence claim is correct.
  return {
    status: "verified",
    note: `absence claim verified: ${candidates.length} candidate(s) all confirmed absent`,
  };
}
