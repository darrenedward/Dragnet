---
name: greploop
description: Review your code changes through the GrepLoop AI review engine. Use when the user asks to review their branch, check their code for bugs, run a code review, fix issues found by review, or invokes /greploop.
user-invocable: true
---

# GrepLoop

GrepLoop is a self-hosted AI code review engine. It indexes the codebase, builds a call graph, and runs an agentic review loop with tool access to find bugs, security issues, and correctness problems — producing findings backed by evidence chains.

You drive it through GrepLoop's HTTP API running at `http://localhost:3000` (the GrepLoop dev server). The review endpoint is synchronous — it blocks until the review completes (typically 30-120s for a full agentic loop).

All MCP API endpoints require authentication. Pass your API key in the `Authorization` header:
```
Authorization: Bearer gl_mcp_<your_key>
```
Generate a key from the GrepLoop UI sidebar → "MCP API Keys" section. If no key is configured, tell the user to create one.

## Three ways to invoke

`/greploop` works in three modes:

- **`/greploop`** or **`/greploop review`** — Review the current branch. Runs the AI review and reports findings to the user.
- **`/greploop fix`** — Review + fix. Runs review, asks user which findings to address, applies the suggested fixes, commits, and re-reviews to confirm.
- **`/greploop status`** — Show the current branch and any existing review results without triggering a new scan.

## What the GrepLoop API returns

`POST /api/hooks/prepush` accepts `{ branch, repoPath, sha }` and returns:

```
{
  "passed": bool,          // true if rating >= 9
  "rating": 1-10,          // overall quality score
  "findings": [            // array of issues found
    {
      "category": "Correctness" | "Security" | "Performance" | "Accessibility" | "Style",
      "severity": "blocker" | "warning" | "suggestion",
      "filename": "path/to/file.ts",
      "line": 42,
      "explanation": "Human-readable explanation",
      "diffSuggestion": "Optional suggested code fix",
      "evidenceChain": [    // multi-hop trace across the codebase
        { "file": "...", "line": 42, "text": "..." }
      ]
    }
  ],
  "message": "Summary string"
}
```

A non-200 response means the repo hasn't been indexed yet or the PR wasn't found. Surface the error message to the user with instructions.

## Auto-fix protocol (`/greploop fix`)

When the user asks to fix findings, follow this loop:

1. **Call review** — `POST /api/hooks/prepush` with the current branch info
2. **Present findings** — Show the user each finding grouped by severity (blocker first). Ask which they want to address.
3. **Apply fixes** — For each selected finding, read the file at the specified line, understand the context, and apply the `diffSuggestion` code change.
4. **Commit** — Commit the fixes with a message like `fix: address GrepLoop review findings`
5. **Re-review** — Call the review endpoint again to confirm the fixes resolved the issues
6. **Report** — Show the final verdict: pass or what remaining issues exist

Only apply fixes the user explicitly approves. For `blocker` findings, recommend fixing them.

## Installing the pre-push hook

Run `npm run greploop install-hooks` (or `npm run install-hooks`) to install the pre-push hook. This copies `scripts/hooks/pre-push` into `.git/hooks/pre-push`. The hook automatically blocks pushes that fail review, acting as a safety net even when you don't explicitly run `/greploop`.

## Preconditions

Before running any review:
- The GrepLoop dev server must be running at `http://localhost:3000`
- Verify with `curl -s http://localhost:3000/api/repos | jq length` — if the response is empty or fails, tell the user to start the server with `npm run dev`.
- The current directory must be inside a git repository with a non-default branch
- The repo must be registered in GrepLoop (visible in the sidebar)
- The repo must have been indexed (open the "Codebase AST graph" tab and run the indexer)
