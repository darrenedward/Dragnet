/**
 * v1 Finding Verifier.
 *
 * Post-candidate, pre-persistence validation of LLM-generated findings.
 * Three layers, two cheap structural rejects plus grounded-in-code checks:
 *
 *   Stage 0 — structural rejects (ALL findings, no disk I/O)
 *     1. Explanation is empty/whitespace → reject
 *        (a finding with no rationale cannot be verified)
 *     2. Cited file is documentation (.md, docs/, .agent-os/, README,
 *        CHANGELOG, etc.) → reject unless `docsReview: true`
 *        (docs are context for understanding intent, not bug locations)
 *
 *   Stage A — line/file validation (ALL findings)
 *     1. File exists
 *     2. Cited line within file bounds
 *     3. Code at line ±5 contains the symbol the finding's explanation
 *        references (substring check — best-effort, false negatives
 *        fall through to Stage B)
 *
 *   Stage B — counter-evidence retrieval (4 finding families only)
 *     - auth          → inspect targeted guardrail files for requireSession,
 *                       authenticateSessionOrKey, authenticateApiRequest,
 *                       verifyGithubSignature
 *     - data-isolation → read cited function, look for `where: { repoId, ... }`
 *     - webhook/network → inspect targeted webhook helpers/routes for HMAC
 *                       verification, signature checks
 *     - concurrency  → read cited function, look for beginReview/endReview,
 *                       $transaction, atomic upserts
 *
 *     Stage B asks the chat LLM to make the final call: given the cited
 *     code + retrieved counter-evidence, does the finding still apply?
 *
 * Invariants:
 *   - Never throws. On any failure (LLM unavailable, parse error, fs
 *     error), the finding is marked `unverified` and persisted as-is.
 *     The verifier is defense-in-depth, not a gate.
 *   - Rejected findings stay in the DB for audit trail — the route
 *     filter is what hides them.
 *   - `downgraded` means "real issue but overstated" — the UI shows a
 *     amber chip but doesn't drop the finding.
 *   - Stage 0 rejects are the cheapest + highest-leverage: they catch
 *     the failure mode where a flash chat model dumps dozens of
 *     findings against docs files with empty explanations.
 *
 * Scope v1: line/file validation + counter-evidence for the 4 families.
 * Full PRD §14.6 5-class taxonomy (confirmed/likely/partially_mitigated/
 * needs_verification/false_positive) deferred to a follow-on spec.
 */

import path from "node:path";
import { prisma } from "@/src/lib/prisma";
import { safeReadFileSync } from "@/src/lib/pathSafety";
import { getChatClient, getChatModel } from "@/src/lib/llmClient";
import { checkAbsenceClaim, extractCitedSymbols } from "./findingVerifier/absenceClaim";

export interface CandidateFinding {
  id: string;
  category: string;
  severity: string;
  filename: string;
  line?: number | null;
  explanation: string;
  source?: string | null;
}

export interface VerificationResult {
  status: "verified" | "downgraded" | "rejected" | "unverified";
  note: string;
}

/**
 * Options for a verification pass.
 *
 *   docsReview — when true, findings citing documentation files
 *                (.md, docs/, .agent-os/, etc.) are NOT auto-rejected.
                Set when the scan's explicit purpose is to review docs
 *                (a future scan mode). Default false — normal PR code
 *                reviews treat docs as context, not bug locations.
 */
export interface VerifyOptions {
  docsReview?: boolean;
}

/**
 * File extensions + path patterns treated as documentation. Findings
 * citing these are auto-rejected in normal code review mode — docs are
 * context for understanding intent, not bug locations.
 *
 * If you add a new doc format, add it here. Anything NOT in this list
 * (.ts, .tsx, .js, .prisma, .sql, .json, .yml, .tf, etc.) stays
 * reviewable.
 */
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

/**
 * Verify a batch of findings. Returns a Map keyed by finding.id so the
 * caller can look up each result in O(1) while building the persistence
 * payload.
 */
export async function verifyFindings(
  findings: CandidateFinding[],
  repoPath: string,
  prId: string,
  options: VerifyOptions = {},
): Promise<Map<string, VerificationResult>> {
  const results = new Map<string, VerificationResult>();

  for (const finding of findings) {
    try {
      const result = await verifyOne(finding, repoPath, prId, options);
      results.set(finding.id, result);
    } catch (err) {
      console.warn(
        `[verifier] finding ${finding.id} (${finding.filename}:${finding.line}) threw — marking unverified:`,
        err,
      );
      results.set(finding.id, {
        status: "unverified",
        note: `verifier error: ${(err as Error).message?.slice(0, 120) || "unknown"}`,
      });
    }
  }

  return results;
}

async function verifyOne(
  finding: CandidateFinding,
  repoPath: string,
  prId: string,
  options: VerifyOptions,
): Promise<VerificationResult> {
  // ─── Stage 0: cheap structural rejects (no disk I/O) ──────────────
  // These two checks catch the failure mode where a flash-style chat
  // model dumps dozens of high-confidence findings against docs files
  // with empty explanations. Both are auto-rejected; the caller filters
  // them out of the UI via the `verificationStatus: { not: "rejected" }`
  // route clause.
  if (!finding.explanation || !finding.explanation.trim()) {
    return {
      status: "rejected",
      note: "finding has no explanation — cannot verify a claim with no rationale",
    };
  }

  if (!finding.filename || finding.filename === "<unattributed>") {
    return {
      status: "rejected",
      note: "finding did not specify a filename — the LLM emitted a finding without citing a source code file. Re-scan after strengthening the prompt.",
    };
  }

  if (!options.docsReview && isDocumentationFile(finding.filename)) {
    return {
      status: "rejected",
      note: `cited file "${finding.filename}" is documentation, not source code — docs are context for the review, not bug locations. Re-cite against the implementation file.`,
    };
  }

  // ─── Stage A: line/file validation ─────────────────────────────────
  const stageA = validateLineAndFile(finding, repoPath, prId);
  if (stageA) return stageA;

  // ─── Stage A.5: absence-claim verification ────────────────────────
  // Catches the failure mode where the LLM reviewer claims a file/route/
  // import does not exist or is unused, but the filesystem contradicts
  // it. Deterministic, no LLM call.
  const stageA5 = checkAbsenceClaim(finding, repoPath);
  if (stageA5) {
    if (stageA5.status === "rejected") {
      console.warn(
        `[verifier] stage A.5 rejected finding ${finding.id} (${finding.filename}:${finding.line}) — ${stageA5.note}`,
      );
    }
    return stageA5;
  }

  // ─── Stage B: counter-evidence retrieval (4 families) ─────────────
  const family = classifyFamily(finding);
  if (!family) {
    return { status: "verified", note: "line/file validation passed" };
  }

  const counterEvidence = retrieveCounterEvidence(finding, family, repoPath);
  if (counterEvidence.length === 0) {
    return { status: "verified", note: `${family}: no counter-evidence found` };
  }

  return await llmVerdict(finding, family, counterEvidence);
}

// ─── Stage A ──────────────────────────────────────────────────────────

function validateLineAndFile(
  finding: CandidateFinding,
  repoPath: string,
  prId: string,
): VerificationResult | null {
  const content = loadFileContent(finding.filename, repoPath, prId);
  if (content === null) {
    return {
      status: "rejected",
      note: `cited file "${finding.filename}" does not exist`,
    };
  }

  if (!finding.line || finding.line < 1) {
    return null;
  }

  const lines = content.split("\n");
  if (finding.line > lines.length) {
    return {
      status: "rejected",
      note: `cited line ${finding.line} is outside file (1..${lines.length})`,
    };
  }

  // Substring check: do the symbols the explanation references appear
  // anywhere in the cited file? We search the whole file, not a ±window
  // around finding.line — explanations routinely cite symbols imported
  // at the top of the file, types defined in sibling functions, or
  // sibling handlers in the same module. The real hallucination signal
  // is "none of the cited symbols appear anywhere in the file", not
  // "not within ±5 lines of the cited line."
  const symbols = extractCitedSymbols(finding.explanation);
  if (symbols.length === 0) return null;

  const missing = symbols.filter((s) => !content.includes(s));
  if (missing.length === symbols.length) {
    return {
      status: "rejected",
      note: `cited symbols ${missing.join(", ")} not found anywhere in "${finding.filename}"`,
    };
  }

  return null;
}

function loadFileContent(
  filename: string,
  repoPath: string,
  _prId: string,
): string | null {
  // v1: disk read only. PrFile-table fallback (for files deleted in
  // working tree but still in the diff) deferred to a follow-on — the
  // vast majority of findings cite files that still exist on disk.
  //
  // filename is LLM-cited via submitReview — untrusted. safeReadFileSync
  // resolves + opens + reads in one step with O_NOFOLLOW, closing the
  // TOCTOU window that resolveSafePath + readFileSync would leave open.
  return safeReadFileSync(repoPath, filename);
}

// ─── Stage B: classification + counter-evidence ──────────────────────

type Family = "auth" | "data-isolation" | "webhook-network" | "concurrency";

function classifyFamily(finding: CandidateFinding): Family | null {
  const text = `${finding.category} ${finding.explanation}`.toLowerCase();

  if (finding.category.toLowerCase() === "security") {
    if (/\b(auth|authentication|authorization|session|api key|bearer|cookie|login|unauthenticated|bypass)\b/.test(text)) {
      return "auth";
    }
    if (/\b(tenant|tenancy|repoId|isolation|cross-repo|multi-tenant|other repo|wrong repo)\b/.test(text)) {
      return "data-isolation";
    }
    if (/\b(webhook|hmac|signature|host header|origin header|x-hub|allowlist|allow.?list|ssrf|dns)\b/.test(text)) {
      return "webhook-network";
    }
  }

  if (finding.category.toLowerCase() === "correctness") {
    if (/\b(race|concurrency|transaction|atomic|lock|mutex|deadlock|order|sequential)\b/.test(text)) {
      return "concurrency";
    }
  }

  return null;
}

function retrieveCounterEvidence(
  finding: CandidateFinding,
  family: Family,
  repoPath: string,
): string[] {
  const patterns = COUNTER_EVIDENCE_PATTERNS[family].map((p) => new RegExp(p, "i"));
  const candidates = candidateCounterEvidenceFiles(finding, family);
  const hits: string[] = [];

  for (const file of candidates) {
    const content = loadRelativeFile(repoPath, file);
    if (!content) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!patterns.some((pattern) => pattern.test(lines[i]))) continue;

      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      const snippet = lines
        .slice(start, end)
        .map((line, offset) => `${start + offset + 1}: ${line}`)
        .join("\n");
      hits.push(`${file}:${i + 1}\n${snippet}`);
      break;
    }
  }

  return hits.slice(0, 8);
}

function candidateCounterEvidenceFiles(finding: CandidateFinding, family: Family): string[] {
  const files = new Set<string>();
  const add = (file?: string | null) => {
    if (file) files.add(file.replace(/\\/g, "/").replace(/^\.\//, ""));
  };

  add(finding.filename);

  if (family === "auth") {
    add("src/proxy.ts");
    add("src/lib/apiAuth.ts");
    add("src/lib/api-auth.ts");
    add("src/lib/auth.ts");
    add("src/app/api/auth/[...all]/route.ts");
  } else if (family === "data-isolation") {
    add("prisma/schema.prisma");
    add("src/lib/findPr.ts");
  } else if (family === "webhook-network") {
    add("src/lib/webhook.ts");
    add("src/lib/webhookSetup.ts");
    add("src/app/api/webhooks/github/route.ts");
    add("src/app/api/webhooks/gitlab/route.ts");
  } else if (family === "concurrency") {
    add("src/lib/reviewLocks.ts");
  }

  return [...files];
}

function loadRelativeFile(repoPath: string, relativePath: string): string | null {
  // Counter-evidence file paths come from candidateCounterEvidenceFiles
  // (repo-relative, hardcoded) — but delegate to safeReadFileSync anyway
  // for consistency with loadFileContent above. The previous
  // `startsWith(resolvedRepoPath + path.sep)` check was the lexical-prefix
  // anti-pattern pathSafety.ts:18 warns against (sibling-directory escape
  // like /home/u/myrepo-vs-/home/u/myrepo-secrets), and also broke on
  // Windows path.sep and case-insensitive filesystems.
  return safeReadFileSync(repoPath, relativePath);
}

const COUNTER_EVIDENCE_PATTERNS: Record<Family, string[]> = {
  auth: [
    "\\brequireSession\\b",
    "\\bauthenticateSessionOrKey\\b",
    "\\bauthenticateApiRequest\\b",
    "\\bverifyGithubSignature\\b",
    "\\bgetSessionCookie\\b",
  ],
  "data-isolation": [
    "where:\\s*\\{[^}]*\\brepoId\\b",
  ],
  "webhook-network": [
    "\\bcreateHmac\\b",
    "\\bverifyGithubSignature\\b",
    "\\btimingSafeEqual\\b",
    "\\bVALID_PROVIDERS\\b",
  ],
  concurrency: [
    "\\bbeginReview\\b",
    "\\bendReview\\b",
    "\\bisReviewActive\\b",
    "\\$transaction",
    "\\bupsert\\b",
  ],
};

// ─── Stage B: LLM verdict ─────────────────────────────────────────────

async function llmVerdict(
  finding: CandidateFinding,
  family: Family,
  counterEvidence: string[],
): Promise<VerificationResult> {
  const client = getChatClient();
  const model = getChatModel();
  if (!client || !model) {
    return {
      status: "unverified",
      note: `${family}: chat LLM not configured — cannot verify counter-evidence`,
    };
  }

  const prompt = buildPrompt(finding, family, counterEvidence);

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    return parseVerdict(text);
  } catch (err) {
    console.warn(`[verifier] LLM call failed for finding ${finding.id}:`, err);
    return {
      status: "unverified",
      note: `${family}: LLM call failed (${(err as Error).message?.slice(0, 80)})`,
    };
  }
}

const SYSTEM_PROMPT = `You are a code review auditor. Given a security/correctness finding and counter-evidence retrieved from the actual codebase, decide whether the finding still applies.

Respond with EXACTLY one of:
- VERIFIED — finding is correct, the cited issue is real
- DOWNGRADED — real issue but overstated (e.g., severity too high, or mitigating control exists)
- REJECTED — finding is wrong, counter-evidence shows the issue is already addressed

Follow with a one-sentence reason on the next line.

Example output:
REJECTED
The finding claims auth is missing, but the cited function calls authenticateSessionOrKey at line 9.`;

function buildPrompt(
  finding: CandidateFinding,
  family: Family,
  counterEvidence: string[],
): string {
  return [
    `Finding (${finding.category}/${finding.severity}):`,
    `File: ${finding.filename}:${finding.line ?? "?"}`,
    `Explanation: ${finding.explanation}`,
    ``,
    `Counter-evidence category: ${family}`,
    `Retrieved from current codebase:`,
    ...counterEvidence.map((c) => `  - ${c}`),
    ``,
    `Does the finding still apply?`,
  ].join("\n");
}

function stripThinkBlocks(s: string): string {
  return s
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think[^>]*>[\s\S]*$/gi, "");
}

function parseVerdict(text: string): VerificationResult {
  const cleaned = stripThinkBlocks(text).trim();
  const firstLine = cleaned.split("\n")[0]?.trim().toUpperCase() ?? "";
  const rest = cleaned.split("\n").slice(1).join(" ").trim();

  if (firstLine.startsWith("VERIFIED")) {
    return { status: "verified", note: rest.slice(0, 200) || "counter-evidence checked" };
  }
  if (firstLine.startsWith("DOWNGRADED")) {
    return { status: "downgraded", note: rest.slice(0, 200) || "real issue but overstated" };
  }
  if (firstLine.startsWith("REJECTED")) {
    return { status: "rejected", note: rest.slice(0, 200) || "counter-evidence contradicts finding" };
  }
  return {
    status: "unverified",
    note: `LLM verdict unparseable: ${text.slice(0, 120)}`,
  };
}
