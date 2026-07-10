# Dragnet Code Review Workflow Audit & Improvement Report

## 1. Executive Summary

Dragnet is a self-hosted, multi-tenant code review platform engineered with a sophisticated multi-tiered architecture. It integrates deterministic checks (linter/compiler feedback), LLM-based agentic scans with search capability, multi-stage evidence verifiers, and an adversarial "skeptic" pass.

This report reviews the current codebase architecture, explores the flow of PR reviews, analyze how deterministic and LLM-driven findings are generated and adjudicated, and offers key recommendations for performance, security, reliability, and cost-efficiency.

---

## 2. Current Workflow Architecture

The core review loop is organized into a tiered pipeline (`reviewService.ts` and `src/services/largePrReview/orchestrator.ts`):

```
                       +-----------------------------+
                       |       PR Scan Triggered      |
                       +--------------+--------------+
                                      |
                                      v
                       +--------------+--------------+
                       |    Large PR Orchestration   |
                       |  - Tier & Limit Validation  |
                       |  - Chunker & Manifest       |
                       +--------------+--------------+
                                      |
                                      v
                       +--------------+--------------+
                       | Global Deterministic Checks |
                       |  - Tier 1: tsc & eslint     |
                       |  - Tier 2: container tests  |
                       +--------------+--------------+
                                      |
                                      v
                       +--------------+--------------+
                       |       LLM Chunk Loop        |
                       |  - Agentic scan / tools     |
                       |  - submitReview finalization |
                       +--------------+--------------+
                                      |
                                      v
                       +--------------+--------------+
                       |     Adjudication Phase      |
                       |  - Verifier (Stage A.5)     |
                       |  - Skeptic Pass (Fallback)  |
                       |  - Rating Rerating/Nulling  |
                       +--------------+--------------+
                                      |
                                      v
                       +--------------+--------------+
                       |      Deduplication          |
                       |  - Intra-run deduplication  |
                       |  - Cross-run reconciliation |
                       +-----------------------------+
```

### Tier 1 & Tier 2: Deterministic Checks
* **Tier 1 (TypeScript Compiler & ESLint):** Executes locally against the repository path (if available). Discovers compile errors, warnings, and code style issues.
* **Tier 2 (Containerized Checks):** Launches inside an ephemeral docker container (e.g. `node:20-alpine`) to install dependencies (`npm install`) and run tests (`npm test && npm run lint`).
* **Optimization (Phase 5):** In Large PR Mode, deterministic checks are run globally *once* prior to the chunk review loop. The findings are passed to all chunks as precomputed findings and persisted under `reviewChunkId: null`.

### Tier 3: LLM Scan
* **Trivial Diff Gate:** If deterministic checks are clean and `classifyDiff` flags the files as trivial (e.g. only config, docs, or lockfiles), the LLM scan is skipped entirely, saving substantial API costs and preventing noise.
* **Agentic Multi-Turn Loop:** For non-trivial PRs, Dragnet mounts an agentic loop powered by an OpenAI-compatible preset model. The LLM has access to tools:
  - `searchCodebase`: Look up symbol locations and summaries.
  - `getCallers`: Trace calling paths in the dependency graph.
  - `findSimilar`: Execute semantic semantic search over vector embeddings.
  - `readFile`: Safely retrieve local file content (bounded by a cumulative buffer limit of 200,000 characters).
  - `submitReview`: Exits the loop and yields a structured JSON payload with findings and an overall quality rating.
* **JSON-Only Finalizer Turn:** If the model exhausts its iteration budget without invoking `submitReview`, a single-turn JSON finalizer is executed with a compacted message history to extract findings deterministically.
* **Refusal Check:** An independent, fast follow-up turn checks if the model skipped any portion of the PR due to safety guardrails, content filters, or out-of-scope conditions.

### Adjudication: Finding Verification & Skeptic Pass
Once candidate findings (both deterministic and LLM-driven) are aggregated, they undergo a rigorous verification phase:
1. **Deterministic Evidence Verifier (`verifyFindings`):** Checks claims made by the model. For instance, Stage A.5 checks for "absence claims" (e.g. "missing route" or "unused import") and cross-references the file-system structure or symbol occurrences. If the file exists or a grep shows the symbol is indeed referenced, the finding is immediately rejected.
2. **Skeptic Pass (`runSkepticPass`):** Evaluates remaining findings against an adversarial fallback LLM model. The skeptic can confirm, downgrade severity, or reject findings.
3. **Rating Calibration:**
   - **All Rejected:** If 10/10 findings are rejected, the rating is nulled, and a warning is issued recommending a re-scan.
   - **Partial Rejected:** Re-prompts the primary model with the survivors and rejection notes to re-calculate a holistic rating, preventing arbitrary numerical scoring penalties.
4. **Deduplication:** Collapses duplicates within a run by unique semantic fingerprints (stable over line shifts) and reconciles state with historical runs.

---

## 3. Workflow Improvements & Key Recommendations

We analyzed the code execution paths and found several high-value optimization, security, and robustness improvements for Dragnet:

### 1. Parallelize Chunk Evaluations in Large PR Mode
* **Current Flow:** The Large-PR Orchestrator processes chunks in a sequential `for (const plan of plans)` loop. In massive repositories, reviewing 8+ chunks sequentially can take a substantial amount of time, especially with fallback attempts.
* **Improvement:** Introduce a configurable parallel execution window (e.g., concurrency limit of 3-5 concurrent chunks) using a pool queue. Ensure checkpointing and logger output are properly prefixed/isolated per chunk to prevent state contention.

### 2. Fine-grained LLM Token Cache & Context Compression
* **Current Flow:** Sanitized messages are sent to the finalizer, but the main agentic loop carries the raw history. Long `readFile` contents can blow up prompt contexts and cost.
* **Improvement:**
  - Inject explicit semantic summary blocks instead of raw files where appropriate.
  - Leverage LLM Prompt Caching features (e.g., Anthropic's prompt caching or OpenRouter supported cache control headers) by ordering system and large manifests at the absolute beginning of the messages list and keeping them static.

### 3. Resilience in Deterministic Checks (Docker Socket Downtime)
* **Current Flow:** Docker socket failures or daemon unresponsive exceptions throw container runner crashes. While these are caught, they flag infrastructure failures.
* **Improvement:** Implement a soft-fallback to running a secure sandboxed linter/check on the host if Docker is unavailable, rather than aborting the scan completely, particularly for internal multi-tenant systems.

### 4. Enhance Grep/Symbols Checks in Absence Claims
* **Current Flow:** Stage A.5 `absenceClaim.ts` does simple substring searches (e.g. `symbol is referenced`).
* **Improvement:** Leverage the call-graph/symbols AST data already inside the Prisma DB for deterministic search checks. Doing an AST lookup is more reliable than simple string checks which might match dead code comments or string literals.

### 5. Expand Language Support beyond TS/JS specs
* **Current Flow:** Tree-sitter grammars are only loaded for TypeScript/JavaScript in V1.
* **Improvement:** Expand tree-sitter specifications to Python and Go. This will enrich AST symbols data and expand deterministic verification checks to multi-language monorepos.

---

## 4. Summary of Code Health Findings
- **High Modularization:** Decoupling logic like failing classifiers, skeptic ratings, and token builders from `reviewService.ts` prevents the main router from growing excessively (obeying codebase constraints).
- **Strong Safety Guarantees:** Strict path traversal prevention via `resolveSafePath` protects host environments from malicious repository structures.
- **Accurate Cost Telemetry:** Telemetry logs persist token usages for both primary and fallback/skeptic models successfully.
