# PRD-2: GrepLoop — Codebase Index, Graph Architecture & Agentic Review Engine

**Status:** Draft v1
**Follows:** PRD-1 (GrepLoop — Local-First Automated PR Review Bot)
**Scope:** The indexing pipeline, call graph, vector store, agentic review loop, and evidence chain system that elevates GrepLoop from "diff reviewer" to "full-codebase reviewer" — closing the quality gap with Greptile.

---

## 0. Why this document exists

PRD-1 specced a working local PR review tool: watcher, trigger modes, LLM backend, report output. It would produce useful reviews. It would not produce *great* reviews.

The gap between useful and great is almost entirely one architectural decision: **Greptile indexes the entire codebase before touching a diff. Every other tool reviews the diff in isolation.**

That difference accounts for Greptile's 82% bug catch rate vs. competitors at 44–54%. The bugs it catches that others miss are invisible from the diff alone — a changed function that breaks callers in files nobody touched, a new implementation that duplicates an existing utility with better edge case handling, a config change that conflicts with a hardcoded assumption three hops away. You cannot catch those from a diff. You need a map of the whole codebase.

This document specifies that map — and the agentic review loop that uses it — as a follow-on piece of work that sits on top of PRD-1's foundation without replacing it.

No part of PRD-1 is invalidated. The watcher, trigger modes, LLM router, and report format all carry forward unchanged. This PRD adds a Phase 0 (indexing) and replaces the single-pass LLM call in the review pipeline with an agentic loop.

---

## 1. What Greptile actually does (confirmed architecture)

Before speccing GrepLoop's version, it's worth being precise about what Greptile's approach actually is — because most descriptions of it are vague ("it understands your codebase") in ways that make it sound like magic. It is not magic. It is a specific pipeline, each part of which is replicable locally with open-source tooling.

**Step 1 — AST parsing with tree-sitter.**
Every file in the repo is parsed into an abstract syntax tree. Tree-sitter is the parser — open source, language-agnostic, supports ~100 languages, runs offline. From the AST, you extract every function, method, class, import statement, and call site: who defines what, where, and who calls whom.

**Step 2 — Natural language summarisation.**
For each function and class extracted from the AST, a quick LLM pass generates a plain-English summary: *"Validates an email address against RFC 5322 format. Returns null on invalid input rather than throwing."* These summaries are what gets embedded — not raw source code. Searching embeddings of natural-language summaries is far more semantically accurate than searching raw code text.

**Step 3 — Hybrid retrieval index.**
The summaries are embedded and stored in a vector store (semantic search). The raw function/class/file names and call relationships are stored in a graph database or structured store (keyword + graph traversal search). Both are used at review time.

**Step 4 — Agentic review loop at PR time.**
When a diff arrives, Greptile does not make a single LLM call. It runs an agent in a loop. The agent has tools: search the code graph, look up a specific function's implementation, query git history for a file, find all callers of a function. The agent decides what to investigate, runs tool calls, receives results, and keeps reasoning until it has enough evidence to produce findings. This is "multi-hop investigation" — following a chain of references across files the same way an experienced engineer does when reviewing an unfamiliar change.

**Step 5 — Evidence chain in output.**
Every finding includes the reasoning trail: which files were consulted, which dependency chain was traced, what the agent concluded and why. This is what makes findings credible rather than arbitrary.

None of these steps require a specially trained model, proprietary data, or cloud infrastructure. The LLM is a standard frontier model (Greptile uses Claude). The parser is tree-sitter (open source). The vector store can be SQLite with a vector extension. The graph can be SQLite with adjacency tables. All of it runs locally.

---

## 2. Scope of this PRD

This document covers:

- **Section 3** — The indexing pipeline (tree-sitter → call graph → docstring generation → embedding)
- **Section 4** — The local index store (schema, incremental update strategy)
- **Section 5** — Retrieval at review time (graph traversal + vector search)
- **Section 6** — The agentic review loop (replacing the single LLM pass from PRD-1)
- **Section 7** — Evidence chains in the report (replacing bare findings)
- **Section 8** — Git history integration
- **Section 9** — Performance targets and index size expectations
- **Section 10** — Revised full pipeline diagram
- **Section 11** — Phase sequencing (what to build in what order)

---

## 3. Indexing Pipeline

The index is built when a project is first registered with GrepLoop and maintained incrementally as files change. It runs independently of the review pipeline — think of it as a background service that keeps a live map of the codebase up to date so that when a review is triggered, the map is already there.

### 3.1 Stage 1 — Tree-sitter parsing

**What it does:** Parses every source file in the repo into an AST and extracts structured information about its contents.

**What gets extracted per file:**
- All function and method definitions: name, parameters (names + types if present), return type if annotated, start/end line, docstring if present in source
- All class and interface definitions: name, parent classes, start/end line
- All import/require statements: what is imported, from where
- All function call sites: which function is called, on which line, with what arguments (names only, not values)
- All exported symbols (for module boundary analysis)

**Tool:** tree-sitter with the appropriate language grammar. Language grammars are installed as needed — GrepLoop detects the languages present in a repo from file extensions and installs only the required grammars, not all 100.

**Languages supported at MVP:** JavaScript, TypeScript, Python, PHP (relevant given your SilverStripe background), Ruby, Go. Additional grammars added on request.

**What tree-sitter does NOT give you:** Resolved types (it's a parser, not a type-checker), runtime values, or dynamic call targets (e.g. `obj[methodName]()`). These are inherent limitations — GrepLoop flags call sites it cannot statically resolve rather than silently dropping them.

**Output:** A structured record per extracted symbol, ready to be inserted into the index store.

### 3.2 Stage 2 — Call graph construction

From the parsed symbols, GrepLoop builds a directed call graph:

- **Nodes:** Functions, methods, classes, files, modules
- **Edges:**
  - `CALLS` — function A calls function B
  - `IMPORTS` — file A imports symbol B from file C
  - `DEFINES` — file A defines function B
  - `EXTENDS` — class A extends class B
  - `OVERRIDES` — method A overrides method B (where detectable)

Edges are stored with their source location (file + line) so the agent can cite them precisely when producing evidence chains.

**Resolution strategy:** Import resolution follows the same rules as the language's own module system. For TypeScript/JS, this means respecting `tsconfig.json` paths and `package.json` exports if present. For Python, it means following `sys.path` conventions. Unresolvable imports (e.g. external npm packages not in the repo) are stored as unresolved edges — they're still useful context (they show *that* an external dependency is called, and from where) but won't have node entries in the graph.

### 3.3 Stage 3 — Docstring generation (LLM pass)

For each function and class in the call graph, GrepLoop generates a natural-language summary if one doesn't already exist in the source.

**Why not embed the raw source code?**
Vector search over raw source code embeddings is syntactically biased — it finds code that *looks* similar, not code that *does* similar things. Embedding natural-language descriptions of what a function does produces far more semantically accurate retrieval. This is the same approach Greptile uses and is the reason their retrieval quality is high.

**The prompt per symbol:**
```
Given this function, write a single concise paragraph (2-4 sentences) in plain English
describing what it does, what it accepts as input, what it returns, and any important
side effects or error conditions. Do not describe implementation details unless they
are the only way to convey the function's behaviour.

Function name: {name}
File: {file_path}
Signature: {signature}
Source:
{source_code}
```

**When to run:** Docstring generation runs on first index of a file, and re-runs for any function whose source changes on subsequent incremental updates. It does NOT re-run for functions whose source is unchanged — the cached summary stays valid.

**Cost consideration:** For cloud LLM backends, this is the most API-call-intensive part of GrepLoop. A codebase with 5,000 functions will make ~5,000 small LLM calls on first index. This is batched and rate-limited, runs in the background, and is a one-time cost amortised over all subsequent reviews. For local LLM backends (Ollama etc.), this is slow but free and genuinely offline.

**Output:** One natural-language summary per symbol, stored alongside the symbol in the index.

### 3.4 Stage 4 — Embedding

Each generated summary is embedded using the configured embedding model:

- **Cloud backend:** OpenAI `text-embedding-3-small` or equivalent — cheap, fast, high quality
- **Local backend:** `nomic-embed-text` via Ollama, or any GGUF-compatible embedding model — fully offline

Embedding vectors are stored in the local vector store (see Section 4) alongside the symbol metadata (file, line, name, language, node type).

---

## 4. Local Index Store

Everything lives in `~/.greploop/index/<project-id>/`. No external database server required.

### 4.1 Storage components

**`graph.db` — SQLite database**

Three tables form the core of the call graph:

```sql
-- Every function, class, file, module
CREATE TABLE symbols (
    id          TEXT PRIMARY KEY,   -- stable hash of file_path + symbol_name + kind
    project_id  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,      -- 'function' | 'class' | 'method' | 'module' | 'file'
    language    TEXT NOT NULL,
    line_start  INTEGER NOT NULL,
    line_end    INTEGER NOT NULL,
    signature   TEXT,               -- raw signature string
    source_hash TEXT NOT NULL,      -- SHA256 of source, used to detect changes
    summary     TEXT,               -- generated natural-language docstring
    summary_at  INTEGER             -- unix timestamp of when summary was generated
);

-- Directed edges between symbols
CREATE TABLE edges (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    from_id     TEXT NOT NULL REFERENCES symbols(id),
    to_id       TEXT REFERENCES symbols(id),    -- nullable for unresolved imports
    to_raw      TEXT,               -- raw unresolved target string when to_id is null
    kind        TEXT NOT NULL,      -- 'calls' | 'imports' | 'defines' | 'extends' | 'overrides'
    file_path   TEXT NOT NULL,
    line        INTEGER NOT NULL
);

-- File-level metadata for incremental update tracking
CREATE TABLE files (
    project_id  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    file_hash   TEXT NOT NULL,      -- SHA256 of file content
    parsed_at   INTEGER NOT NULL,   -- unix timestamp
    PRIMARY KEY (project_id, file_path)
);
```

**`vectors.db` — SQLite with sqlite-vec extension**

Stores embedding vectors alongside symbol IDs for semantic search. sqlite-vec is a lightweight SQLite extension for vector operations — no separate vector database server needed.

```sql
CREATE VIRTUAL TABLE symbol_embeddings USING vec0(
    symbol_id   TEXT,
    embedding   FLOAT[1536]    -- dimension matches embedding model; adjust for local models
);
```

**Why SQLite for everything?**
It's a single file per component, zero setup, zero server process, works offline, trivially backed up, and handles codebases up to at least tens of millions of symbols without performance issues at GrepLoop's query patterns. A future multi-user hosted version would swap this out for Postgres + pgvector, but that's a one-component swap, not a schema redesign.

### 4.2 Incremental update strategy

Rebuilding the full index on every file change would be too slow for large repos. GrepLoop uses file-level dirty tracking:

1. A filesystem watcher (same one used by PRD-1's branch watcher) also watches for file changes in registered projects.
2. On any file change, GrepLoop computes `SHA256(file_content)` and compares to `files.file_hash`.
3. If unchanged: skip. If changed or new:
   - Re-parse with tree-sitter.
   - Diff extracted symbols against existing symbols for that file.
   - For changed/new symbols: regenerate summary, re-embed, update graph edges.
   - For removed symbols: delete from symbols, edges, and vector store.
   - Update `files.file_hash` and `files.parsed_at`.
4. Deletions: if a file is deleted from the repo, all its symbols and edges are pruned from the index.

This means the index is always current within seconds of a file save, without full re-indexing. The first index of a large repo is the slow step (minutes to hours depending on size and LLM backend speed); all subsequent updates are incremental and fast.

### 4.3 Index size expectations

Rough estimates for planning:

| Repo size | Functions/classes | graph.db | vectors.db | First index time (cloud LLM) | First index time (local LLM) |
|---|---|---|---|---|---|
| Small (<5k LOC) | ~200 | <1 MB | ~2 MB | 2–5 min | 10–20 min |
| Medium (5k–50k LOC) | ~2,000 | ~8 MB | ~20 MB | 15–30 min | 1–3 hrs |
| Large (50k–200k LOC) | ~8,000 | ~30 MB | ~80 MB | 1–2 hrs | 4–12 hrs |
| Very large (200k+ LOC) | ~30,000+ | ~100 MB | ~300 MB | 3–6 hrs | 24+ hrs |

For very large repos on local LLM backends, initial indexing is genuinely slow. GrepLoop should:
- Show progress (files parsed / total, symbols summarised / total).
- Allow reviews to proceed on partial indexes (with a clear warning that retrieval quality will be reduced until indexing completes).
- Never block the user from doing other things while indexing runs.

---

## 5. Retrieval at Review Time

When a diff arrives, GrepLoop needs to pull the right slice of the codebase into the LLM's context window. This is a retrieval problem, and it uses two complementary strategies run in parallel.

### 5.1 Seed extraction from the diff

Before any retrieval, GrepLoop identifies the "seed" symbols from the diff — the functions, methods, and classes that appear in changed lines. These are the starting points for both retrieval strategies.

```
diff → changed file paths + changed line ranges
     → query symbols table for symbols whose (file_path, line_start, line_end)
       overlaps with changed line ranges
     → seed symbol set
```

### 5.2 Graph traversal (structural context)

From each seed symbol, traverse the call graph to collect structurally related symbols:

- **Callers (depth 2):** Every function that calls a seed symbol (direct callers), and every function that calls those callers (one level up). These are the functions most likely to break if the seed's behaviour changes.
- **Callees (depth 1):** Every function the seed calls. These provide context on what the seed depends on.
- **Co-importers:** Every file that imports the same modules as the changed files — these files share dependencies and may be affected by changes to shared state.
- **Class hierarchy:** If a changed method belongs to a class, include the full inheritance chain (parent classes, child classes) and their overrides of the same method.

Depth limits are configurable (default: callers depth 2, callees depth 1) because deep traversal of a large, highly-connected codebase could pull in half the repo. The agent can request deeper traversal as a tool call if it determines the default depth is insufficient for a specific finding.

### 5.3 Vector search (semantic context)

For each seed symbol's generated summary, run a vector similarity search across all embedded summaries to find functions elsewhere in the codebase that do semantically similar things.

This catches the "duplicate utility" class of bug — where a changed function reimplements something that already exists with better edge case handling — which graph traversal alone will not find because there's no call relationship between the two functions.

Search returns the top-K results (default K=10) ranked by cosine similarity, filtered to exclude symbols already retrieved by graph traversal.

### 5.4 Git history retrieval

For each changed file in the diff, retrieve recent git history:

```bash
git log --oneline -20 <file_path>         # last 20 commits touching this file
git log -p -3 <file_path>                 # full diff of last 3 commits on this file
```

This gives the agent access to:
- Whether this code was recently changed (high churn = higher regression risk).
- What the previous implementation looked like (useful for spotting regressions).
- Commit messages describing why changes were made (useful for understanding intent).

### 5.5 Context assembly and token budgeting

The retrieved symbols, git history, and diff are assembled into a context payload for the LLM. This payload has a token budget — what fits depends on the LLM backend:

| Backend | Usable context budget (leaving room for output) |
|---|---|
| Claude Sonnet (cloud) | ~180,000 tokens |
| GPT-4o (cloud) | ~120,000 tokens |
| Local 7B model (Ollama) | ~6,000 tokens |
| Local 13B model (Ollama) | ~12,000 tokens |
| Local 32B+ model (Ollama) | ~30,000+ tokens |

The gap between cloud and local models here is significant. Local 7B models have context windows that cannot hold a large diff plus retrieved context simultaneously. GrepLoop handles this by:

- Prioritising: diff always fits first. Callers/callees next. Semantic results last. Git history last.
- Truncating low-priority retrieved context gracefully (noting in the report what was excluded due to context limits).
- For local backends, reducing graph traversal depth and vector search K automatically to fit within the available window.
- Clearly noting in each review report: which LLM backend was used, how much context was available, and what percentage of the retrieved context fit within it.

This means local-model reviews will be genuinely less thorough than cloud-model reviews for large diffs — GrepLoop should not hide this. The report should surface it explicitly so the user can decide whether to re-run with a cloud backend.

---

## 6. Agentic Review Loop

This is the core change from PRD-1's single-pass LLM call. Instead of one call with all the context, the review is an agent with tools running a loop.

### 6.1 Why a loop matters

A single LLM call with a pre-assembled context is fundamentally limited: you retrieve what you think is relevant before the LLM has seen the diff. The agent approach inverts this — the LLM sees the diff first, forms hypotheses, and then *requests* the specific additional context it needs to confirm or refute them. This is closer to how a skilled human reviewer actually works.

In practice this means the agent can say: *"This function calls `processPayment` — show me its implementation"* or *"has `auth.ts` been modified recently? Show me the last three commits"* or *"find all functions in this codebase that interact with the `sessions` table"* — and GrepLoop executes those queries against the local index and returns results, without the LLM needing all of that pre-loaded into its initial context.

### 6.2 Agent tools

The agent has the following tools, executed by GrepLoop locally against the index:

```
search_codebase(query: string, limit?: number) → symbol[]
  Semantic search over embedded summaries. Returns matching symbols with
  file, line, name, and summary. Use for: "find all functions that handle
  authentication", "find utilities that format dates".

get_symbol(file_path: string, symbol_name: string) → symbol
  Retrieve a specific function or class by name and file path. Returns
  full source code, signature, summary, and generated docstring.

get_callers(symbol_id: string, depth?: number) → symbol[]
  Return all functions that call the given symbol, up to depth levels.
  Default depth 2. Use when a changed function's callers need checking.

get_callees(symbol_id: string) → symbol[]
  Return all functions the given symbol calls. Use when a changed function's
  dependencies need checking.

get_file_history(file_path: string, num_commits?: number) → commit[]
  Return recent git log for a file, including commit messages and diffs.
  Default 5 commits. Use when recent churn or previous implementations
  are relevant.

get_file_contents(file_path: string, line_start?: number, line_end?: number) → string
  Return raw file contents, optionally sliced to a line range. Use when
  full file context around a changed area is needed.

find_similar(symbol_id: string, limit?: number) → symbol[]
  Return semantically similar symbols from across the codebase.
  Use for detecting duplicate implementations or related utilities.
```

### 6.3 Loop structure

```
INITIAL PROMPT:
  You are reviewing a pull request on a local branch. Your job is to identify
  real bugs, security issues, and correctness problems — not style preferences
  unless they indicate a deeper problem. Focus on issues that could cause
  incorrect behaviour, data loss, security vulnerabilities, or broken contracts
  between components.

  You have tools to explore the codebase. Use them. Do not produce findings
  based on the diff alone if you suspect a cross-file issue — investigate first.
  For every finding you produce, you must be able to cite the specific evidence
  you found. If you cannot cite evidence, do not produce the finding.

  Here is the diff:
  {diff}

  Here is the initially retrieved context (callers, callees, related symbols):
  {initial_context}

LOOP:
  while agent has tool calls pending:
    execute tool calls → return results to agent
    agent continues reasoning

  agent signals DONE → extract findings from final output

MAX ITERATIONS: 10 (configurable, default 10 — prevents runaway loops on
  large diffs with deeply connected codebases)
```

### 6.4 Finding format from the agent

The agent is instructed to produce findings in a structured format that GrepLoop can parse reliably:

```
FINDING:
  category: correctness | security | performance | accessibility | style
  severity: blocker | warning | suggestion
  file: path/to/file.ts
  line: 42
  title: One-line description of the issue
  explanation: Plain English explanation of why this is a problem
  evidence:
    - file: path/to/other-file.ts, line: 88 — function `processPayment` called here
      will receive null when input is undefined, but has no null guard
    - file: path/to/utils.ts, lines: 12-28 — existing `validateInput` utility
      handles this case; consider using it instead
  suggested_fix: |
    Optional short code snippet showing a fix. Mark as suggestion only.
    Do not auto-apply.
  confidence: high | medium | low
```

The `evidence` block is the key addition over PRD-1's report format. Every finding must have at least one evidence entry — a specific file and line reference from the codebase that supports the claim. Findings the agent cannot support with evidence are discarded before the report is assembled.

### 6.5 Confidence scoring

Each finding gets a confidence score:

- **High** — agent found direct code evidence of the bug (e.g. a null dereference path that can be traced end-to-end through actual code)
- **Medium** — agent found strong circumstantial evidence (e.g. a pattern that is usually a bug, in a context where it is likely to manifest)
- **Low** — agent found a potential issue but cannot confirm it without runtime information or deeper analysis

Low-confidence findings are included in the report but visually separated and explicitly noted as needing human judgment. This is how GrepLoop controls the false-positive rate — rather than suppressing uncertain findings entirely (which loses real bugs) or flooding the report with noise, it lets the developer triage by confidence.

---

## 7. Evidence Chains in the Report

This replaces the bare "file + line + explanation" format from PRD-1.

Each finding in the rendered report includes a collapsible evidence trail:

```markdown
## FINDING: Null dereference in payment handler [BLOCKER] [HIGH CONFIDENCE]

**File:** `src/payments/handler.ts`, line 142
**Category:** Correctness

`processPayment()` calls `getUser(userId)` which can return `null` when the
user session has expired (see auth.ts:88). On line 142, the return value is
passed directly to `chargeCard()` without a null check. `chargeCard()` does
not handle null input (see billing.ts:34) and will throw an uncaught exception,
which the global error handler logs but does not surface to the caller — meaning
the payment appears to succeed to the caller while actually failing.

<details>
<summary>Evidence (3 files traced)</summary>

- `src/auth/session.ts:88` — `getUser()` explicitly returns `null` on session
  expiry: `if (!session) return null`
- `src/billing/charge.ts:34` — `chargeCard()` destructures its input immediately:
  `const { amount, currency } = user` — throws TypeError on null
- `src/payments/handler.ts:142` — call site with no null check:
  `const charged = chargeCard(getUser(userId), amount)`
- `git log src/payments/handler.ts` — this file was last modified 3 days ago
  (commit: "refactor payment flow") — the null return from getUser was added in
  the same commit, suggesting the null check was overlooked during refactor

</details>

**Suggested fix:**
```typescript
const user = getUser(userId);
if (!user) {
  return { success: false, error: 'Session expired' };
}
const charged = chargeCard(user, amount);
```
*(Suggestion only — not auto-applied)*
```

This format makes findings defensible. The developer can see exactly how the agent reasoned, check the cited lines themselves, and make an informed decision rather than blindly trusting or dismissing the finding.

---

## 8. Git History Integration

Git history is used in two ways in GrepLoop, beyond what PRD-1 described.

### 8.1 Churn scoring

Files with high recent churn (many commits in a short period) are statistically more likely to contain bugs. GrepLoop computes a churn score per changed file:

```
churn_score = (commits_touching_file_in_last_30_days) /
              (days_since_file_created + 1)
```

Files above a configurable churn threshold (default: more than 5 commits in 30 days) are flagged with a "high churn" indicator in the report, and the agent is given explicit instruction to be more thorough in its investigation of these files.

### 8.2 Regression detection context

For each changed function, GrepLoop retrieves the git diff of that function from the last 3 commits that touched it. This gives the agent the ability to see:

- Whether a bug was previously fixed in the same location and may be being reintroduced.
- What the previous implementation of a function looked like, to reason about whether the new version is strictly equivalent or may have changed behaviour.
- The commit messages that explain *why* the code was written the way it was.

This context is passed to the agent as part of its initial context for any changed function that has recent history — it is not a tool call, it is pre-loaded because it is almost always relevant when a function has been changed recently.

---

## 9. Performance Targets

| Operation | Target | Notes |
|---|---|---|
| First index (small repo, cloud LLM) | < 5 min | One-time cost |
| First index (medium repo, cloud LLM) | < 30 min | One-time cost |
| Incremental file update | < 10 sec per file | After any file save |
| Branch diff detection → review start | < 5 sec | Watcher + trigger latency |
| Review pass (cloud LLM, small diff <100 lines) | < 2 min | Including agent loop |
| Review pass (cloud LLM, large diff 500+ lines) | < 8 min | More agent iterations |
| Review pass (local 7B model, small diff) | < 5 min | Limited context |
| Review pass (local 32B model, small diff) | < 15 min | Depends on hardware |
| Report render (local web UI) | < 1 sec | Already-generated report |

These are targets, not guarantees. Actual times depend heavily on hardware (for local models), API rate limits (for cloud), repo size, and diff complexity. GrepLoop should display real timing in every report so the user can calibrate expectations.

---

## 10. Revised Full Pipeline Diagram

This supersedes the pipeline diagram in PRD-1 Section 8.

```
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 0 — INDEX (runs on registration, maintained continuously)       │
│                                                                         │
│  Filesystem Watcher                                                    │
│       │ file changed                                                   │
│       ▼                                                                │
│  Tree-sitter Parser ──────────► Call Graph Builder                    │
│       │                               │                               │
│       │ symbols extracted             │ edges computed                │
│       ▼                               ▼                               │
│  Docstring Generator (LLM)     SQLite: graph.db                      │
│       │                               │                               │
│       │ natural language summaries    │                               │
│       ▼                               │                               │
│  Embedding Model ─────────────► SQLite: vectors.db (sqlite-vec)      │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 1 — TRIGGER (unchanged from PRD-1)                              │
│                                                                         │
│  Branch Watcher → Trigger Evaluator (auto / mention) → Review Queue  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 2 — RETRIEVAL                                                    │
│                                                                         │
│  git diff ──► Seed Extraction                                         │
│                    │                                                   │
│         ┌──────────┴──────────┐                                       │
│         ▼                     ▼                                       │
│   Graph Traversal        Vector Search        Git History             │
│   (callers/callees)    (semantic similar)   (recent commits)          │
│         │                     │                   │                   │
│         └──────────┬──────────┘                   │                   │
│                    ▼                               │                   │
│           Token Budget Assembly ◄─────────────────┘                  │
│                    │                                                   │
│                    ▼                                                   │
│             Initial Context Payload                                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 3 — AGENTIC REVIEW LOOP                                          │
│                                                                         │
│  LLM Agent ◄─── Initial Prompt (diff + initial context)              │
│      │                                                                 │
│      ├─── tool call: search_codebase("...")                           │
│      │         └── GrepLoop executes → returns results                │
│      ├─── tool call: get_callers("processPayment")                    │
│      │         └── GrepLoop executes → returns results                │
│      ├─── tool call: get_file_history("auth.ts")                     │
│      │         └── GrepLoop executes → returns results                │
│      │    ... (up to max_iterations tool call rounds)                 │
│      │                                                                 │
│      └─── DONE signal → structured findings output                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 4 — REPORT ASSEMBLY (evolved from PRD-1)                        │
│                                                                         │
│  Parse findings → validate evidence citations → assign confidence     │
│       │                                                                │
│       ▼                                                                │
│  Markdown report + JSON report → ~/.greploop/reports/<proj>/<branch>/ │
│       │                                                                │
│       ▼                                                                │
│  Local Web UI (evidence chains, collapsible traces, confidence tiers) │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Phase Sequencing — What to Build in What Order

The indexing and agentic loop is more complex than PRD-1's baseline, so the sequencing matters. Building the whole thing at once before validating any of it is a trap. Recommended order:

**Phase A — Get the index working (no agent yet)**
Build tree-sitter parsing + call graph + SQLite storage. No LLM involved yet. Output: a `greploop index status` command that shows the indexed symbol count and call graph edge count for a registered project. Validate that the graph is correct for a known small repo before touching the LLM pipeline.

**Phase B — Add docstring generation and embedding**
Wire in the LLM call per symbol and the vector store. Output: a `greploop search "handles authentication"` command that runs a semantic search against the local index and returns matching symbols with file/line. Validate retrieval quality manually on a real codebase before wiring it to review.

**Phase C — Replace single-pass review with agentic loop**
Replace PRD-1's single LLM call with the agent loop + tool implementations. Start with the simplest tool set (get_callers, get_symbol, search_codebase) and add git history tools after the core loop is working.

**Phase D — Evidence chains and confidence scoring**
Evolve the report format from PRD-1's bare findings to the evidence chain format specified in Section 7. This is a reporting-layer change, not an architecture change — the findings are already there, the format is what changes.

**Phase E — Tune and calibrate**
Run the full pipeline against real local repos. Measure false positive rate and catch rate manually. Tune the prompt in Section 6.3, token budget priorities in Section 5.5, and graph traversal depths in Section 5.2 based on real results.

---

## 12. Open Questions

- **Embedding model for local backend:** `nomic-embed-text` is the current best local embedding model for code retrieval, but this is a fast-moving space. Worth re-evaluating at build time.
- **sqlite-vec maturity:** sqlite-vec is actively developed but relatively new. If it proves unstable for GrepLoop's query patterns, `chromadb` (embedded Python, no server) is a drop-in alternative for the vector store component only.
- **Max agent iterations:** Default of 10 is a guess. Needs empirical validation — too low and the agent stops before following an important lead; too high and runaway loops on deeply connected codebases run for too long and cost too much on cloud backends.
- **PHP/SilverStripe-specific tree-sitter grammar:** tree-sitter-php exists and is mature. SilverStripe's template language (.ss files) is not covered by any tree-sitter grammar. GrepLoop should treat `.ss` files as plain text for MVP — they're presentation layer, rarely the source of the bugs this tool is designed to catch.
- **Comment threading against the index:** PRD-1 proposed an inline comment system on review reports. With evidence chains now in the report, comments should be threadable against specific evidence entries, not just finding titles. Worth speccing in PRD-3 once the index architecture is built and working.