# PRD: BugHunter — In-House Code Review Platform

**Status:** Draft v4 (pivots the wedge from privacy to cost + control + multi-LLM ensemble; renames GrepLoop → BugHunter)
**Owner:** you
**Target:** Engineers and small teams who want Greptile-tier review quality without Greptile's per-seat pricing, with the freedom to pick — or ensemble — any LLM.

> **Rename note:** the codebase is mid-rename from GrepLoop to BugHunter. The agent's system prompt (`reviewService.ts`) already identifies as BugHunter. Package name, env vars (`GREPLOOP_API_KEY`), config dir (`.greploop/`), CLI script (`scripts/greploop.mjs`) will be migrated separately — see Open Questions §19.

---

## 1. Summary

**BugHunter** is a self-hosted code review platform that combines:

1. **Full-codebase indexing** (tree-sitter → call graph → LLM summaries → vector embeddings) — the architectural decision that separates Greptile-tier review quality from diff-only reviewers.
2. **An agentic review loop** — instead of one LLM call with pre-assembled context, an agent with tools (search the code graph, get callers, read git history) investigates the diff and produces findings backed by evidence chains.
3. **Multi-LLM ensemble reviews** — run the same PR through N models and reconcile findings. Surface agreements as high-confidence, disagreements as explicit judgment calls. No commercial reviewer offers this.
4. **Bring-your-own everything** — repo source (local folder or remote clone), LLM backend (cloud or local), embedding model (independent of chat model). No per-seat subscription. No vendor lock-in.

The platform runs inside infrastructure you control. Code goes only where you point it.

---

## 2. Problem Statement

Greptile and CodeRabbit provide context-aware code review as a hosted SaaS. The friction isn't privacy — it's pricing and control:

- **Per-seat pricing punishes team growth.** Greptile starts around $30/user/mo + usage. A 10-engineer team reviewing across 30 repos pays thousands per year whether they review one PR or a thousand.
- **You don't pick the model.** The vendor chooses. If you'd rather review security-critical diffs with Claude and stylistic diffs with GPT-4, you can't.
- **No cross-model verification.** A single model's blind spots are baked in. There's no way to ask "what do three different frontier models agree is wrong with this PR?"
- **Your review history lives in their database.** Export is an afterthought. Retention is their policy.

BugHunter closes those gaps. Same review quality as Greptile, running on hardware you control, with the model choice and the cost curve in your hands.

**Where privacy lands in this pitch:** it's a side effect, not the headline. Code goes where you point it — to a cloud LLM provider if you configure one, nowhere if you don't. If keeping code fully off third-party networks matters to you, the pure-local deployment mode (§4) delivers it. If it doesn't, the hybrid modes are cheaper and faster.

---

## 3. The Wedge

Three concrete things BugHunter does that Greptile/CodeRabbit can't or won't:

1. **No per-seat pricing, ever.** One install, unlimited repos, unlimited PRs, unlimited reviewers. The only cost curve is your LLM bill — and you control that by picking cheaper models for cheap diffs.
2. **Multi-LLM ensemble reviews.** Run the same diff through Claude, GPT-4, and Gemini. Reconcile. This is the feature Greptile structurally cannot offer because they pick the model for you.
3. **Model freedom.** Use OpenRouter to swap models per repo. Use a local Ollama for the embedding role and a frontier cloud model for the chat role. Change tomorrow without filing a support ticket.

---

## 4. Deployment Modes

BugHunter is deployed inside infrastructure you control. Four modes, picked per-repo at config time. All four are supported by the existing codebase — the schema is filesystem-path based, the LLM client is endpoint-agnostic.

| Mode | Repo source | LLM (chat) | Embeddings | What leaves the box |
|---|---|---|---|---|
| **Pure local** | folder with `.git` | Ollama, same box | Ollama, same box | nothing |
| **Local repo + cloud LLM** | folder with `.git` | OpenRouter / Anthropic / OpenAI | Ollama, same box | diff only |
| **Remote repo + local LLM** | deploy-key clone | Ollama on server | Ollama on server | code clone (one-time + fetches) |
| **Remote repo + cloud LLM** | deploy-key clone | OpenRouter / Anthropic / OpenAI | Ollama on server, or cloud | diff (and embeddings if cloud) |

**Mode 1 — Pure local.** Point BugHunter at a folder containing `.git`. Run Ollama on the same machine. Nothing leaves the box. This is the simplest case and the most defensible "Greptile alternative that runs on my laptop" pitch.

**Mode 2 — Local repo, cloud LLM.** Same as Mode 1 but the chat role hits a cloud endpoint. Code stays on disk; only the diff and retrieved context are sent to the LLM provider. This is the practical default for users without a local GPU (see §5).

**Mode 3 — Remote repo, local LLM.** BugHunter runs on a server. Repos are cloned via GitHub deploy key (read-only, scoped per-repo, revocable). LLM is local Ollama. Code clones into your perimeter; nothing leaves for an LLM provider.

**Mode 4 — Remote repo, cloud LLM.** Same as Mode 3 but chat hits a cloud LLM. The closest analog to Greptile's architecture — but you pick the model, you pay the actual LLM cost (not a markup), and you can still ensemble.

**Deploy keys vs. GitHub App:** deploy keys are the MVP path — one SSH key per repo, registered at GitHub, no UI overhead. GitHub App support lands later for orgs that want a single install across many repos with audit logs.

---

## 5. Hardware Reality

A common assumption is that "self-hosted" implies running frontier models locally. In practice, the two roles have very different hardware requirements:

- **Chat / review role.** Frontier models (Claude Sonnet, GPT-4-class, GLM-5.2, MiniMax-M3) need serious hardware to run locally at review-grade speed — a high-end GPU or a workstation like NVIDIA's DGX Spark. Most users don't have that. For these users, the chat role should hit a cloud endpoint (OpenRouter, Anthropic, OpenAI). The cost is per-diff, typically cents to low dollars per PR.
- **Embedding role.** Embedding models (`nomic-embed-text`, `bge-small`, etc.) are small and CPU-friendly. They run fine locally even on modest hardware. Recommended default: local Ollama for embeddings regardless of where chat runs.

**The hybrid (Mode 2 in §4) is the practical default for most users:** local repo, local embeddings, cloud LLM for the review itself. Code stays on disk; only the diff and retrieved context leave for the LLM provider; the cost curve is your actual LLM usage. This is fully supported by `src/lib/llmClient.ts` — chat and embedding roles are configured independently via `.greploop/llm-presets.json`.

If you later acquire hardware capable of running frontier local models, flip the chat role to local Ollama and the cost curve drops to electricity.

---

## 6. Multi-LLM Ensemble Reviews (headline feature)

This is the structural wedge against every commercial reviewer. They run one model. You don't have to.

### 6.1 The flow

1. PR triggers review.
2. BugHunter runs the full agent loop (§14) against N configured models in parallel — each model gets the same diff, same indexed context, same tools.
3. Each model returns its own findings and rating as a `ReviewPass`.
4. A reconciliation layer produces the final report:
   - **Agreement findings** (flagged by ≥2 models) → promoted to high confidence.
   - **Single-model findings** → kept, marked with which model raised them.
   - **Rating disagreement** → surface the spread explicitly. Don't average blindly; let the human see "Claude says 10/10, GPT-4 says 4/10 — investigate."
5. UI shows the reconciled report with per-model breakdowns available on demand.

### 6.2 Why this matters

- **Catches blind spots.** Different model families have different failure modes. A finding two of three models agree on is far more likely to be real.
- **Calibrates trust.** When three frontier models all rate a PR 10/10 with zero findings, that's stronger evidence than any single model's verdict.
- **Cost tunable.** Run a cheap model on every PR, escalate to expensive models only on disagreement or low-rating PRs.

### 6.3 Schema implication

Current schema has `PullRequest.rating` (single int). Ensemble needs:

- New `ReviewPass` model — one row per (PR, model, run). Stores the model identifier, rating, summary, raw findings, token usage, latency, timestamp.
- `PullRequest` keeps a reconciled `rating` and `reconciledSummary`.
- `ReviewFinding` gains optional `reviewPassId` so individual findings trace back to the model that raised them.

See §18 for the schema diff.

---

## 7. Core Concepts

| Term | Meaning |
|---|---|
| **Repository** | A git repository registered with BugHunter. Has a filesystem path (local clone or local-only repo). Belongs to one install. |
| **Local PR** | A branch that differs from the configured base branch. Not a GitHub/GitLab PR object — there may be no remote at all. |
| **Base branch** | The branch a local PR is diffed against (typically `main`), configurable per repo. |
| **Review pass** | One execution of the agent loop against a diff snapshot, by one model. Multi-LLM ensemble runs N passes per review. |
| **Review** | The reconciled output of one or more review passes against a single PR snapshot. |
| **Index** | Tree-sitter-parsed, LLM-summarised, vector-embedded map of an entire repo. Built on registration, maintained incrementally. |
| **Finding** | A specific issue raised by a model: category, severity, file, line, explanation, evidence chain, confidence. |
| **Evidence chain** | The list of files/lines/commits the agent consulted to reach a finding. Required on every finding. |

---

## 8. Repo Sources

A repo is registered with BugHunter by pointing it at a filesystem path containing `.git`. How the code got to that path is up to you:

### 8.1 Local-only repo
Folder initialised with `git init`. No remote configured. Fully local — commits, branches, diffs all work without ever pushing. BugHunter reads `.git/refs/heads` and `.git/logs/HEAD` directly. This is the default mode.

### 8.2 Cloned repo (manual)
You `git clone` a remote into a path visible to BugHunter. BugHunter reads the local clone; you handle `git fetch` yourself when you want fresh changes.

### 8.3 Cloned repo (deploy key, MVP target for remote-repo workflows)
BugHunter manages the clone itself. You provide:
- Repo URL (e.g. `git@github.com:you/repo.git`)
- Deploy key (SSH private key, registered at GitHub as a read-only deploy key for that repo)

BugHunter clones into its working directory and runs `git fetch` on each review trigger. Read-only, scoped per-repo, revocable.

### 8.4 GitHub App (post-MVP)
Single install across many repos. Granular permissions. Audit trail. Polished but heavier setup.

---

## 9. LLM Backend Configuration

Two independent roles, each configurable separately:

- **Chat role** — drives the agent review loop. Pick based on quality and cost.
- **Embedding role** — drives semantic search during indexing. Almost always fine to run locally.

Configured via `.greploop/llm-presets.json` (gitignored, mode 0600). Each preset has: name, endpoint URL, API key, model identifier. Source of truth is `src/lib/llmPresets.ts`. Old `.env.local` LLM vars auto-migrate into one preset on first read.

**Supported endpoints (any OpenAI-compatible):**
- Cloud: OpenRouter, Anthropic (via OpenAI-compatible proxy or direct SDK), OpenAI, Mistral, Together, Groq.
- Local: Ollama, LM Studio, llama.cpp server, vLLM.

**Per-repo override:** each repo can specify which chat preset and which embedding preset to use. Default is the install-global preset. This is what enables ensemble reviews (§6) — different repos (or different passes within one review) can hit different presets.

---

## 10. Trigger Modes

### 10.1 Auto-inspect
A filesystem/git watcher polls `.git/refs/heads` and `.git/logs/HEAD` for branch changes. When a qualifying branch is detected, BugHunter waits for a quiet period (default: 5 minutes of no new commits) before triggering review.

### 10.2 Mention-triggered
Three mechanisms, lowest friction first:
1. **CLI / API** — `bughunter review <branch>` or the "Review now" button in the UI.
2. **Marker file** — presence of `.bughunter-review` in the branch's working tree triggers review on the next watcher poll, then the marker is consumed.
3. **Commit message marker** — a commit message containing `@BugHunter review` (configurable) triggers review of that branch.

### 10.3 Pre-push hook
Git pre-push hook (`scripts/hooks/pre-push`) calls `POST /api/hooks/prepush`, which runs `runPrScan()` and returns a pass/fail verdict. Blocks pushes that score below threshold (default: rating < 8/10). Bypass with `git push --no-verify`.

---

## 11. Codebase Indexing Pipeline

The index is built when a repo is first registered and maintained incrementally as files change. It runs independently of the review pipeline — a background service that keeps a live map of the codebase so that when a review is triggered, the map is already there.

### 11.1 Stage 1 — Tree-sitter parsing
Parses every source file into an AST and extracts: function/method definitions (name, params, return type, line range), class/interface definitions, import statements, call sites, exported symbols.

**Languages at MVP:** JavaScript, TypeScript, Python, PHP, Ruby, Go. Additional grammars installed on demand based on detected file extensions.

**Limitations:** Tree-sitter is a parser, not a type-checker. It doesn't resolve types or dynamic call targets. BugHunter flags call sites it cannot statically resolve rather than silently dropping them.

**Non-negotiable:** v1 indexing must use real tree-sitter parsers, not regex or hand-rolled pattern matching. Regex extraction is acceptable only as throwaway scaffolding while wiring the rest of the pipeline. The Greptile-tier claim depends on stable AST node ranges, import/call-site structure, and repeatable symbol identity; regex parsing cannot provide enough precision for evidence validation or counter-evidence retrieval.

### 11.2 Stage 2 — Call graph construction
Directed graph with edges: `CALLS`, `IMPORTS`, `DEFINES`, `EXTENDS`, `OVERRIDES`. Edges store source location (file + line) so the agent can cite them precisely in evidence chains. Import resolution follows the language's module system; unresolvable imports are stored as unresolved edges.

### 11.3 Stage 3 — Docstring generation (LLM pass)
For each function and class, BugHunter generates a natural-language summary if one doesn't already exist in source.

**Why not embed raw source?** Vector search over raw source is syntactically biased — it finds code that *looks* similar, not code that *does* similar things. Embedding natural-language descriptions produces far more semantically accurate retrieval. Same approach Greptile uses.

**Cost:** most API-call-intensive part on cloud backends. A codebase with 5,000 functions makes ~5,000 small LLM calls on first index. Batched, rate-limited, runs in background. For local backends (Ollama), slow but free.

### 11.4 Stage 4 — Embedding
Each summary is embedded using the configured embedding model. Stored alongside symbol metadata using Postgres + pgvector (§12).

---

## 12. Index Store

All index state lives in the same Postgres database as users, repos, and review history. **One database, no split-brain.**

### 12.1 Storage components
- **`symbols`** — every function, class, file, module. Fields: id, repoId, filePath, name, kind, language, lineStart, lineEnd, signature, sourceHash, summary, summaryAt, embedding.
- **`edges`** — directed edges between symbols. Fields: id, repoId, fromId, toId (nullable for unresolved), toRaw, kind, filePath, line.
- **`files`** — file-level metadata for incremental tracking. Fields: repoId, filePath, fileHash, parsedAt.

### 12.2 Why Postgres + pgvector
- One datastore for everything — no separate SQLite/Vector DB to manage or back up.
- Supabase provides pgvector out of the box; no extension install needed.
- Transactional consistency — when a repo is deleted, its symbols/edges/files delete in the same transaction.
- Postgres + pgvector handles codebases up to millions of symbols at BugHunter's query patterns. Beyond that, a dedicated vector DB (Qdrant, Weaviate) can slot in as a swap.

### 12.3 Incremental update strategy
1. Filesystem watcher detects file changes.
2. Compute `SHA256(file_content)`, compare to `files.fileHash`.
3. If unchanged: skip. If changed or new: re-parse with tree-sitter, diff extracted symbols, regenerate summaries/embeddings for changed symbols, update graph edges, update `files.fileHash` and `files.parsedAt`.
4. File deletions prune all associated symbols and edges.

First index of a large repo is the slow step (minutes to hours depending on size and LLM backend); subsequent updates are incremental and finish in seconds.

---

## 13. Retrieval at Review Time

When a diff arrives, BugHunter pulls the right slice of the codebase into the agent's context.

### 13.1 Seed extraction from the diff
Changed file paths + changed line ranges → query `symbols` for symbols whose `(filePath, lineStart, lineEnd)` overlaps → seed symbol set.

### 13.2 Graph traversal (structural context)
From each seed symbol:
- **Callers (depth 2)** — functions that call the seed, plus functions that call those callers. Most likely to break if the seed's behaviour changes.
- **Callees (depth 1)** — functions the seed calls.
- **Co-importers** — files that import the same modules.
- **Class hierarchy** — full inheritance chain and overrides.

Depth limits configurable. Agent can request deeper traversal as a tool call if defaults are insufficient for a specific finding.

### 13.3 Vector search (semantic context)
For each seed symbol's summary, run vector similarity search across all embedded summaries. Catches the "duplicate utility" class of bug — where a changed function reimplements something that already exists. Returns top-K (default K=10), filtered to exclude symbols already retrieved by graph traversal.

### 13.4 Git history retrieval
For each changed file: `git log --oneline -20 <file>` and `git log -p -3 <file>`. Gives the agent: whether this code was recently changed (churn = regression risk), previous implementation, commit messages describing intent.

### 13.5 Token budgeting
Retrieved symbols, git history, and diff are assembled with a token budget that depends on the model. **Priority order when truncating:** diff always fits first → callers/callees → semantic results → git history. Every report explicitly notes which model was used, how much context was available, and what percentage of retrieved context fit.

---

## 14. Agentic Review Loop

The core differentiator from diff-only reviewers. Instead of one LLM call with pre-assembled context, the review is an agent with tools running a loop.

### 14.1 Why a loop matters
A single LLM call with pre-assembled context is fundamentally limited: you retrieve what you think is relevant before the LLM has seen the diff. The agent approach inverts this — the LLM sees the diff first, forms hypotheses, then *requests* the specific context it needs to confirm or refute them. Closer to how a skilled human reviewer works.

### 14.2 Agent tools
```
searchCodebase(query)        → symbol[]   semantic search over embedded summaries
getCallers(symbolId)         → symbol[]   functions that call the given symbol
findSimilar(query)           → symbol[]   semantically similar code via embeddings
readFile(filePath)           → numbered source file content scoped to the repo
submitReview(rating, summary, findings[])  terminal — ends the loop
```

### 14.3 Loop structure
System prompt establishes the reviewer role and review criteria. User message contains the diff, pre-fetched context, and the mission. Loop runs up to 8 iterations: model emits tool calls, BugHunter executes them against the index, results go back to the model. Model terminates by calling `submitReview` with rating, summary, and findings.

### 14.4 Finding format
```
category:      Correctness | Security | Performance | Accessibility | Style
severity:      blocker | warning | suggestion
filename:      path/to/file.ts
line:          42
explanation:   plain-English description of the issue
diffSuggestion: optional code snippet showing a fix
confidence:    0.0–1.0
evidenceChain: [{file, line, text}, ...]   multi-hop trace
```

Every finding must have at least one evidence entry — a specific file and line reference from the codebase that supports the claim. Findings the agent cannot support with evidence are discarded before report assembly.

### 14.5 Counter-evidence verification
The review model produces **candidate findings**, not final findings. Before anything is persisted or shown as a blocker, BugHunter runs a verification pass that tries to disprove each claim.

For every candidate finding, the verifier must gather counter-evidence based on category and file type:

- **Auth/security route findings** — inspect route handler, `proxy.ts`/middleware, auth helpers, API-key/session utilities, caller path, and matcher exclusions.
- **Data isolation findings** — inspect Prisma schema, `where` clauses, caller-supplied repo/org context, unique constraints, and route params.
- **Webhook/network findings** — inspect provider parsing, target URL construction, body overrides, env defaults, HMAC/token verification, and API base allowlists.
- **Race/concurrency findings** — inspect locks, transactions, idempotency, background jobs, retry behavior, and shared mutable state.
- **Framework/library findings** — use official docs or MCP/web search for framework semantics, but repo-specific exploitability must still be proven from local code.

The verifier classifies each candidate:

```
status: confirmed | likely | partially_mitigated | needs_verification | false_positive
finalSeverity: blocker | warning | suggestion
finalConfidence: 0.0-1.0
supportingEvidence: [{file, line, text}, ...]
counterEvidence: [{file, line, text, effect}, ...]
assumptions: string[]
```

Publishing rules:

- `false_positive` findings are discarded.
- `needs_verification` findings cannot be blockers.
- `partially_mitigated` findings must explicitly describe the mitigation and cannot use absolute wording like "NO authentication" or "trivial bypass."
- `blocker` findings require a complete entrypoint-to-impact chain plus counter-evidence checked.
- Findings with invalid file paths, nonexistent lines, or empty evidence chains are discarded.

### 14.6 Fallback behavior
If no LLM is configured, the review returns no findings, `rating: null`, and an actionable `systemWarn` explaining that the chat model is unconfigured or unavailable. BugHunter must never silently fabricate procedural findings in normal operation. Any demo findings must be gated behind an explicit `DEMO_MODE=true` flag and visually labeled as demo output.

### 14.7 Current implementation gap audit
As of 2026-06-24, the current codebase is aligned with the PRD architecture but not yet compliant with the PRD bar:

- `IndexingService` still uses custom pattern matching for symbol/call extraction. Replace it with tree-sitter before claiming v1 indexing quality.
- `searchCodebase` currently performs name/substring lookup; semantic search exists separately as `findSimilar`. The tool contract should match the PRD: semantic search over embedded summaries.
- Edge kind casing must be normalized between index writes and review reads (`call` vs `CALLS`) so caller/callee retrieval actually works.
- Candidate findings are persisted after enum clamping but before evidence validation or counter-evidence verification. Add the verifier before rendering blockers.
- `ReviewPass` and ensemble reconciliation are not in the current schema yet; single-model review remains the v1 default, but the schema hook should land before Phase 1.5.

---

## 15. Evidence Chains & Report Format

Each finding in the rendered report includes a collapsible evidence trail:

```markdown
## FINDING: Null dereference in payment handler [BLOCKER] [HIGH CONFIDENCE]

**File:** `src/payments/handler.ts`, line 142
**Category:** Correctness

`processPayment()` calls `getUser(userId)` which can return `null`...

<details>
<summary>Evidence (3 files traced)</summary>
- `src/auth/session.ts:88` — `getUser()` explicitly returns `null` on session expiry
- `src/billing/charge.ts:34` — `chargeCard()` destructures input immediately, throws on null
- `src/payments/handler.ts:142` — call site with no null check
</details>

**Suggested fix:** *(suggestion only — not auto-applied)*
```

**Confidence scoring:**
- **High (>0.8)** — direct code evidence of the bug, traceable end-to-end.
- **Medium (0.4–0.8)** — strong evidence, but at least one assumption remains.
- **Low (<0.4)** — potential issue but cannot confirm without runtime info. Not eligible for blocker severity and visually separated if shown.

Every rendered finding also includes counter-evidence status:

```markdown
**Verification:** Partially mitigated — route handler has no API-key check, but `src/proxy.ts` gates `/api/prs/*` by Better Auth session cookie. Downgraded from unauthenticated blocker to defense-in-depth warning.
```

**Summary metrics** at the top of every report: total findings by category and severity, files changed, lines changed, model(s) used, review pass duration, context-window utilisation.

---

## 16. Review Criteria

Each category can be toggled per-repo.

- **Correctness** — logic errors, off-by-one, unhandled errors, null/type safety gaps, test coverage gaps for changed logic.
- **Security (OWASP-aligned)** — injection risks, broken access control, crypto flaws, hardcoded secrets, SSRF, path traversal. *BugHunter is not OWASP-certified tooling; findings are a first pass, not a security audit.*
- **Performance** — N+1 queries, unbounded loops on user input, blocking operations on request paths, Core Web Vitals patterns (web projects).
- **Accessibility (web projects only)** — missing alt text, non-semantic interactive elements, missing form labels, heading hierarchy skips.
- **Style & maintainability** — inconsistent naming, oversized functions/files relative to codebase norms, dead code introduced by the diff.

---

## 17. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│ BUGHUNTER SERVER (Docker, runs inside your infrastructure)                │
│                                                                            │
│  ┌──────────────┐    ┌────────────────┐    ┌─────────────────────────┐   │
│  │ Next.js Web  │    │ Route Handlers │    │ Background Workers      │   │
│  │ (UI: repos,  │◄──►│ (auth, repos,  │◄──►│ (watcher, indexer,      │   │
│  │ PRs, reports)│    │ reviews, API)  │    │ review runner, ensemble)│   │
│  └──────────────┘    └────────┬───────┘    └──────────┬──────────────┘   │
│                               │                        │                  │
│                               ▼                        ▼                  │
│                       ┌──────────────────────────────────────────────┐   │
│                       │   PostgreSQL (Supabase or self-managed)       │   │
│                       │   • repos, pull_requests, pr_files            │   │
│                       │   • review_passes, review_findings            │   │
│                       │   • symbols, edges, files (code graph)        │   │
│                       │   • symbol embeddings (pgvector)              │   │
│                       └──────────────────────────────────────────────┘   │
│                                                                            │
│                       ┌──────────────────────────────────────────────┐   │
│                       │   Local filesystem (your git repos)           │   │
│                       │   ← watcher reads .git, runs git diff/show    │   │
│                       │   ← indexer reads source files                │   │
│                       └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ (per-repo config)
                       ┌──────────────────────────────────────────────┐
                       │   Cloud LLM (OpenRouter / Anthropic / OpenAI) │
                       │   ← used only if cloud backend is configured  │
                       │   ← embedding role may run locally regardless │
                       └──────────────────────────────────────────────┘
```

**Form factor:** one Docker image containing web UI, API, and background workers. You provide a Postgres connection string (Supabase or self-managed) and filesystem paths to git repos. Everything else is bundled.

---

## 18. Schema Implications for Ensemble Reviews

Current schema has `PullRequest.rating` (single int) and `ReviewFinding` (no model attribution). To support multi-LLM ensemble (§6), add:

```prisma
model ReviewPass {
  id           String   @id @default(cuid())
  prId         String
  model        String   // e.g. "anthropic/claude-sonnet-4.6"
  rating       Int
  summary      String
  tokenUsage   Int?
  latencyMs    Int?
  status       String   // completed | failed | in_progress
  timestamp    DateTime @default(now())
  pullRequest  PullRequest @relation(fields: [prId], references: [id], onDelete: Cascade)
  findings     ReviewFinding[]

  @@map("review_passes")
}

model ReviewFinding {
  // ... existing fields ...
  reviewPassId String?
  reviewPass   ReviewPass? @relation(fields: [reviewPassId], references: [id])
}
```

`PullRequest` retains its `rating` field, now interpreted as the reconciled rating. Add `reconciledSummary: String?` for the merged summary text. Reconciliation logic lives in a new `src/services/ensembleService.ts` — takes N `ReviewPass` rows, produces agreement/disagreement-grouped findings and a final rating.

For single-model reviews (the current default), one `ReviewPass` is created per run and reconciliation is a passthrough.

---

## 19. Open Questions

- **Codebase rename logistics.** `package.json` name, `GREPLOOP_API_KEY` env var, `.greploop/` config dir, `scripts/greploop.mjs` CLI, `src/lib/llmPresets.ts` migration logic that reads `.greploop/`. Need a migration plan that doesn't break existing installs — likely read-old-if-new-doesn't-exist for one release.
- **Tree-sitter package strategy.** MVP should ship TypeScript/JavaScript tree-sitter first and add Python/Go/Rust/PHP/Ruby one at a time. Decide whether grammars are bundled in the Docker image or loaded as optional packages.
- **Counter-evidence verifier storage.** Short term: store verifier status/counter-evidence inside `ReviewFinding.evidenceChain` JSON. Longer term: add explicit columns (`verificationStatus`, `counterEvidence`, `assumptions`) once the shape stabilizes.
- **Ensemble reconciliation strategy.** Average ratings? Take the median? Surface the spread and let humans decide? Default should be "surface the spread" — averaging hides the most interesting signal. Needs empirical tuning once the feature ships.
- **Cost escalation policy.** When ensembling, do all N models run on every PR, or does a cheap model run first and expensive models only escalate on disagreement/low-rating? Likely the latter for cost, but worth measuring.
- **Embedding model for local backend.** `nomic-embed-text` is the current best local embedding model for code. Fast-moving space; re-evaluate at build time.
- **Max agent iterations.** Default of 8 is a guess. Needs empirical validation — too low and the agent stops before following an important lead; too high and runaway loops on deeply connected codebases cost too much on cloud backends.
- **Per-user vs per-install LLM API keys.** MVP is per-install (one config). Per-user keys (BYO OpenRouter key) is a Phase 2 candidate if multi-user lands.

---

## 20. MVP Scope

**In scope for v1:**
- Single-tenant install (one install = one user/team; schema doesn't preclude multi-tenant later).
- Repo registration: local folder, manual clone, or deploy-key clone.
- Phase 0 indexing: real tree-sitter parsers → call graph → LLM summaries → pgvector embeddings, incremental updates.
- Agentic review loop with tools, producing evidence-backed findings.
- Counter-evidence verification before findings are persisted or rendered as blockers.
- Single-model reviews (ensemble is the headline Phase 1.5 feature, schema lands in v1).
- Auto and mention trigger modes; pre-push git hook.
- Cloud-API and local-Ollama backends, configurable per-repo, chat and embedding roles independent.
- Web UI for browsing reports with evidence chains and history.
- API key system for programmatic access (CLI, hooks, integrations). Bearer-auth keys (`gl_` prefix; legacy `gl_mcp_` keys still authenticate) gate `/api/command`, `/api/prcheck`, `/api/prcomments`, `/api/hooks/prepush`. The `/gloop` Claude Code skill drives the same endpoints via `GREPLOOP_API_KEY`.

**Out of scope for v1:**
- Multi-LLM ensemble reconciliation UI (schema lands in v1, reconciliation logic + UI is Phase 1.5).
- Multi-user auth (Better Auth models exist in schema, not wired to repos).
- GitHub/GitLab PR comment-posting (reviews are read-only in v1).
- VS Code extension / inline IDE annotations.
- GitHub App install flow (deploy keys cover the use case for now).
- Auto-fix application (suggestions remain manual-apply only).
