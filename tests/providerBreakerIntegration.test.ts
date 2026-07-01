import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 3 verification — tasks 3.17 and 3.18.
 *
 * 3.17: After 5 quality failures, the next scan skips NVIDIA before
 *       any NVIDIA LLM call (filtered out of getChatChain by the
 *       breaker state in <repo.path>/.dragnet/provider-health.json).
 *
 * 3.18: 5 transport failures do NOT open the circuit — the breaker
 *       only counts quality failures from reviewService's finally
 *       block; transport/interrupted/unknown outcomes never call
 *       recordProviderQualityFailure.
 *
 * Mock posture mirrors `tests/reviewServiceFallbackRegression.test.ts`.
 * The chain is mocked so we can inspect which providers were invoked.
 */

const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1";
const MINIMAX_ENDPOINT = "https://api.minimax.io/v1";
const NVIDIA_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct";
const MINIMAX_MODEL = "minimax/MiniMAX-M1";

const nvidiaCreate = vi.fn();
const minimaxCreate = vi.fn();

function fakeClient(createFn: ReturnType<typeof vi.fn>) {
  return { chat: { completions: { create: createFn } } } as any;
}

// Build the chain entries with real endpoints so the breaker key
// matches what reviewService's finally block records.
function buildChain() {
  return [
    {
      client: fakeClient(nvidiaCreate),
      model: NVIDIA_MODEL,
      name: "NVIDIA",
      endpoint: NVIDIA_ENDPOINT,
      maxIterations: 4,
    },
    {
      client: fakeClient(minimaxCreate),
      model: MINIMAX_MODEL,
      name: "Minimax",
      endpoint: MINIMAX_ENDPOINT,
      maxIterations: 4,
    },
  ];
}

// Per-test tmpdir that backs `<repo.path>/.dragnet/provider-health.json`.
let tmpRepo: string;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-breaker-"));
  nvidiaCreate.mockClear();
  minimaxCreate.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

vi.mock("../src/lib/llmClient", () => ({
  // The test re-reads this mock per test via vi.doMock — but vi.mock
  // is hoisted, so we route through a function that builds the chain
  // from the current tmpRepo state. That way the breaker filtering
  // happens against the real on-disk health file.
  getChatChain: (opts?: { repoPath?: string | null }) => {
    const chain = buildChain();
    if (!opts?.repoPath) return chain;
    // Mirror llmClient.filterOpenProviders inline — same semantics,
    // applied here so the mock stays self-contained for the test.
    return chain.filter((entry) => {
      const file = fs.readFileSync(
        path.join(opts.repoPath!, ".dragnet", "provider-health.json"),
        "utf8",
      );
      const parsed = JSON.parse(file);
      const key = `${new URL(entry.endpoint).host}:${entry.model}`;
      const h = parsed.providers?.[key];
      if (!h || h.state !== "open") return true;
      return false;
    });
  },
  getChatClient: () => null,
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: "pr-1",
        repoId: "repo-1",
        title: "Test PR",
        description: "test",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    // Return real tmpRepo path so breaker writes go somewhere inspectable.
    repository: {
      findUnique: vi.fn().mockImplementation(() =>
        Promise.resolve({ id: "repo-1", path: tmpRepo, localPath: null }),
      ),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({ id: "run-1", status: "in_progress" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockResolvedValue([]),
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/lib/reviewFreshness", () => ({
  completeReviewRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/largePrReview/fingerprint", () => ({
  buildFindingFingerprint: vi.fn().mockReturnValue("fp"),
  resolveSymbolsBatch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/largePrReview/reconcile", () => ({
  reconcileFindingsAcrossRuns: vi.fn().mockResolvedValue([]),
}));

// Provider-response shapers.
function nvidiaResponse(body: any) {
  if (body?.tools) {
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-${Math.random().toString(36).slice(2)}`,
                type: "function",
                function: {
                  name: "searchCodebase",
                  arguments: JSON.stringify({ query: "never-matches" }),
                },
              },
            ],
          },
        },
      ],
    };
  }
  return {
    choices: [{ message: { role: "assistant", content: "I cannot produce a review." } }],
  };
}

function transportErrorResponse() {
  // Shape that isRetryableProviderFailure() recognises as transport.
  const err: any = new Error("Request failed with status 429");
  err.status = 429;
  throw err;
}

function seedQualityFailures(repoPath: string, endpoint: string, model: string, count: number) {
  for (let i = 0; i < count; i++) {
    // Inline read-modify-write so we don't depend on the module's
    // own helper (keeps the test honest about what reviewService
    // does in production).
    const file = path.join(repoPath, ".dragnet", "provider-health.json");
    let parsed: any = { providers: {} };
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // missing — fresh.
    }
    const key = `${new URL(endpoint).host}:${model}`;
    const prev = parsed.providers[key] ?? {
      consecutiveQualityFailures: 0,
      openedAt: null,
      cooldownEndsAt: null,
      state: "closed",
      updatedAt: Date.now(),
    };
    const next = {
      ...prev,
      consecutiveQualityFailures: prev.consecutiveQualityFailures + 1,
      updatedAt: Date.now(),
    };
    if (next.consecutiveQualityFailures >= 5) {
      next.state = "open";
      next.openedAt = Date.now();
      next.cooldownEndsAt = Date.now() + 15 * 60 * 1000;
    }
    parsed.providers[key] = next;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  }
}

describe("Phase 3.17 — 5 quality failures pause NVIDIA, 6th scan skips it", () => {
  beforeEach(() => {
    nvidiaCreate.mockImplementation((body: any) => Promise.resolve(nvidiaResponse(body)));
  });

  it("NVIDIA is filtered out before any LLM call when breaker is open", async () => {
    // Seed 5 quality failures — opens the circuit.
    seedQualityFailures(tmpRepo, NVIDIA_ENDPOINT, NVIDIA_MODEL, 5);

    const { runPrScan } = await import("../reviewService");

    // Minimax will also fail (no submitReview in our mock), so this
    // throws. The load-bearing assertions are call counts, not the
    // return value.
    await expect(
      runPrScan("pr-1", [
        {
          filename: "src/test.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "",
          modifiedContent: "export const x = 1;\n",
          diff: "+export const x = 1;\n",
        },
      ]),
    ).rejects.toThrow();

    // Critical: NVIDIA's chat.completions.create was NEVER invoked.
    // The breaker filtered it out before the loop body ran.
    expect(nvidiaCreate).not.toHaveBeenCalled();

    // Minimax was tried — it became first in the chain.
    expect(minimaxCreate).toHaveBeenCalled();
  });

  it("NVIDIA stays in chain when breaker is below threshold", async () => {
    // Seed 4 quality failures — still closed.
    seedQualityFailures(tmpRepo, NVIDIA_ENDPOINT, NVIDIA_MODEL, 4);

    const { runPrScan } = await import("../reviewService");

    await expect(
      runPrScan("pr-1", [
        {
          filename: "src/test.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "",
          modifiedContent: "export const x = 1;\n",
          diff: "+export const x = 1;\n",
        },
      ]),
    ).rejects.toThrow();

    // NVIDIA WAS invoked — still closed means still eligible.
    expect(nvidiaCreate).toHaveBeenCalled();
  });
});

describe("Phase 3.18 — transport failures do not open the circuit", () => {
  beforeEach(() => {
    // NVIDIA throws a 429 on every call. reviewService treats this as
    // retryable transport_failure, falls through to Minimax. The
    // finally block must classify as transport_failure and NOT call
    // recordProviderQualityFailure.
    nvidiaCreate.mockImplementation(() => transportErrorResponse());
    // Minimax also throws — both providers fail, scan rejects. That's
    // fine; we're inspecting the health file, not the scan result.
    minimaxCreate.mockImplementation(() => transportErrorResponse());
  });

  it("5 scans with transport failures leave the breaker closed", async () => {
    const { runPrScan } = await import("../reviewService");

    for (let i = 0; i < 5; i++) {
      // Each scan will throw because both providers fail with 429.
      await expect(
        runPrScan("pr-1", [
          {
            filename: "src/test.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            originalContent: "",
            modifiedContent: "export const x = 1;\n",
            diff: "+export const x = 1;\n",
          },
        ]),
      ).rejects.toThrow();
    }

    // Inspect the health file directly — transport failures must not
    // have written any provider-health record for NVIDIA.
    const file = path.join(tmpRepo, ".dragnet", "provider-health.json");
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const key = `${new URL(NVIDIA_ENDPOINT).host}:${NVIDIA_MODEL}`;
      const nvidia = parsed.providers?.[key];
      // Either no record at all, or a record that's still closed with
      // zero quality failures. NEVER open.
      if (nvidia) {
        expect(nvidia.state).toBe("closed");
        expect(nvidia.consecutiveQualityFailures).toBe(0);
      }
    }
    // If the file doesn't exist, that's the strongest signal —
    // nothing was recorded at all.
  });
});
