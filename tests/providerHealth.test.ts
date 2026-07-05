import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  breakerKeyFor,
  decideState,
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  getBreakerCooldownMs,
  getBreakerThreshold,
  getProviderHealth,
  healthFilePath,
  listProviderHealth,
  readHealthFile,
  recordProviderQualityFailure,
  recordProviderSuccess,
  recordQualityFailure,
  recordSuccess,
  resetProviderHealth,
  writeHealthFile,
  type CircuitState,
  type Health,
  type ProviderHealthFile,
} from "../src/lib/providerHealth";

// Module doesn't currently export freshHealth — re-imported via test helper below.
function freshHealth(now: number): Health {
  return {
    consecutiveQualityFailures: 0,
    openedAt: null,
    cooldownEndsAt: null,
    state: "closed",
    updatedAt: now,
  };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DRAGNET_BREAKER_") && !(k in ORIGINAL_ENV)) {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("DRAGNET_BREAKER_")) process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// breakerKeyFor
// ---------------------------------------------------------------------------

describe("breakerKeyFor", () => {
  it("extracts host from a https URL", () => {
    expect(breakerKeyFor("https://openrouter.ai/api/v1", "gpt-5")).toBe("openrouter.ai:gpt-5");
  });

  it("extracts host including port", () => {
    expect(breakerKeyFor("http://localhost:1234/v1", "qwen")).toBe("localhost:1234:qwen");
  });

  it("falls back to regex strip for non-URL input", () => {
    expect(breakerKeyFor("localhost:8080", "llama")).toBe("localhost:8080:llama");
  });

  it("produces the same key for the same host+model regardless of path", () => {
    const a = breakerKeyFor("https://integrate.api.nvidia.com/v1", "nvidia/llama-3.1-nemotron-70b-instruct");
    const b = breakerKeyFor("https://integrate.api.nvidia.com/v2", "nvidia/llama-3.1-nemotron-70b-instruct");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// getBreakerThreshold / getBreakerCooldownMs
// ---------------------------------------------------------------------------

describe("getBreakerThreshold", () => {
  it("returns default when env unset", () => {
    delete process.env.DRAGNET_BREAKER_THRESHOLD;
    expect(getBreakerThreshold()).toBe(DEFAULT_BREAKER_THRESHOLD);
    expect(DEFAULT_BREAKER_THRESHOLD).toBe(5);
  });

  it("returns env value when valid positive integer", () => {
    process.env.DRAGNET_BREAKER_THRESHOLD = "3";
    expect(getBreakerThreshold()).toBe(3);
  });

  it("falls back to default on non-positive or NaN", () => {
    process.env.DRAGNET_BREAKER_THRESHOLD = "0";
    expect(getBreakerThreshold()).toBe(DEFAULT_BREAKER_THRESHOLD);
    process.env.DRAGNET_BREAKER_THRESHOLD = "-1";
    expect(getBreakerThreshold()).toBe(DEFAULT_BREAKER_THRESHOLD);
    process.env.DRAGNET_BREAKER_THRESHOLD = "banana";
    expect(getBreakerThreshold()).toBe(DEFAULT_BREAKER_THRESHOLD);
  });
});

describe("getBreakerCooldownMs", () => {
  it("defaults to 15 minutes", () => {
    delete process.env.DRAGNET_BREAKER_COOLDOWN_MS;
    expect(getBreakerCooldownMs()).toBe(DEFAULT_BREAKER_COOLDOWN_MS);
    expect(DEFAULT_BREAKER_COOLDOWN_MS).toBe(15 * 60 * 1000);
  });

  it("respects explicit override", () => {
    process.env.DRAGNET_BREAKER_COOLDOWN_MS = "60000";
    expect(getBreakerCooldownMs()).toBe(60000);
  });
});

// ---------------------------------------------------------------------------
// decideState
// ---------------------------------------------------------------------------

describe("decideState", () => {
  it("returns 'closed' for undefined health", () => {
    expect(decideState(undefined, 1000)).toBe("closed");
  });

  it("returns stored state for closed", () => {
    const h = freshHealth(1000);
    expect(decideState(h, 2000)).toBe("closed");
  });

  it("returns 'open' before cooldown ends", () => {
    const h: Health = {
      ...freshHealth(1000),
      state: "open",
      openedAt: 1000,
      cooldownEndsAt: 2000,
    };
    expect(decideState(h, 1500)).toBe("open");
  });

  it("returns 'half-open' once cooldown has elapsed", () => {
    const h: Health = {
      ...freshHealth(1000),
      state: "open",
      openedAt: 1000,
      cooldownEndsAt: 2000,
    };
    expect(decideState(h, 2000)).toBe("half-open");
    expect(decideState(h, 5000)).toBe("half-open");
  });

  it("returns 'half-open' for stored half-open", () => {
    const h: Health = { ...freshHealth(1000), state: "half-open" };
    expect(decideState(h, 9999)).toBe("half-open");
  });

  it("does not mutate the stored state when promoting open→half-open", () => {
    const h: Health = {
      ...freshHealth(1000),
      state: "open",
      openedAt: 1000,
      cooldownEndsAt: 2000,
    };
    decideState(h, 9000);
    expect(h.state).toBe("open"); // unchanged on disk
  });
});

// ---------------------------------------------------------------------------
// recordQualityFailure (pure)
// ---------------------------------------------------------------------------

describe("recordQualityFailure — closed → open path", () => {
  const NOW = 10_000;
  const THRESHOLD = 5;
  const COOLDOWN = 1000;

  it("increments counter while below threshold, stays closed", () => {
    const h = recordQualityFailure(undefined, NOW, THRESHOLD, COOLDOWN);
    expect(h.consecutiveQualityFailures).toBe(1);
    expect(h.state).toBe("closed");
    expect(h.openedAt).toBeNull();
    expect(h.cooldownEndsAt).toBeNull();
  });

  it("opens the circuit when counter reaches threshold", () => {
    let h: Health | undefined = undefined;
    for (let i = 1; i <= THRESHOLD; i++) {
      h = recordQualityFailure(h, NOW + i * 10, THRESHOLD, COOLDOWN);
    }
    expect(h!.consecutiveQualityFailures).toBe(THRESHOLD);
    expect(h!.state).toBe("open");
    expect(h!.openedAt).toBe(NOW + THRESHOLD * 10);
    expect(h!.cooldownEndsAt).toBe(NOW + THRESHOLD * 10 + COOLDOWN);
  });

  it("does not open before threshold", () => {
    let h: Health | undefined = undefined;
    for (let i = 1; i < THRESHOLD; i++) {
      h = recordQualityFailure(h, NOW + i, THRESHOLD, COOLDOWN);
    }
    expect(h!.state).toBe("closed");
  });
});

describe("recordQualityFailure — half-open → open path", () => {
  const NOW = 10_000;
  const THRESHOLD = 5;
  const COOLDOWN = 1000;

  it("half-open quality failure reopens immediately and resets cooldown", () => {
    const halfOpen: Health = {
      ...freshHealth(NOW),
      state: "half-open",
      consecutiveQualityFailures: THRESHOLD,
      openedAt: NOW - 5000,
      cooldownEndsAt: NOW - 100, // expired → half-open
    };
    const next = recordQualityFailure(halfOpen, NOW, THRESHOLD, COOLDOWN);
    expect(next.state).toBe("open");
    expect(next.openedAt).toBe(NOW);
    expect(next.cooldownEndsAt).toBe(NOW + COOLDOWN);
    // Counter pinned to threshold so a subsequent closed-state failure
    // still hits threshold on the next increment.
    expect(next.consecutiveQualityFailures).toBe(THRESHOLD);
  });
});

describe("recordQualityFailure — open path stays open", () => {
  const NOW = 10_000;
  const THRESHOLD = 5;
  const COOLDOWN = 1000;

  it("another failure while open refreshes cooldown", () => {
    const open: Health = {
      ...freshHealth(NOW),
      state: "open",
      consecutiveQualityFailures: THRESHOLD,
      openedAt: NOW,
      cooldownEndsAt: NOW + COOLDOWN,
    };
    const next = recordQualityFailure(open, NOW + 100, THRESHOLD, COOLDOWN);
    expect(next.state).toBe("open");
    expect(next.cooldownEndsAt).toBe(NOW + 100 + COOLDOWN);
    expect(next.consecutiveQualityFailures).toBe(THRESHOLD + 1);
  });
});

// ---------------------------------------------------------------------------
// recordSuccess (pure)
// ---------------------------------------------------------------------------

describe("recordSuccess", () => {
  const NOW = 10_000;

  it("creates a clean record from undefined", () => {
    const h = recordSuccess(undefined, NOW);
    expect(h.state).toBe("closed");
    expect(h.consecutiveQualityFailures).toBe(0);
    expect(h.openedAt).toBeNull();
    expect(h.cooldownEndsAt).toBeNull();
  });

  it("resets an open circuit on success", () => {
    const open: Health = {
      ...freshHealth(NOW),
      state: "open",
      consecutiveQualityFailures: 7,
      openedAt: NOW,
      cooldownEndsAt: NOW + 1000,
    };
    const next = recordSuccess(open, NOW + 50);
    expect(next.state).toBe("closed");
    expect(next.consecutiveQualityFailures).toBe(0);
    expect(next.openedAt).toBeNull();
    expect(next.cooldownEndsAt).toBeNull();
  });

  it("resets a half-open circuit on success (standard breaker pattern)", () => {
    const halfOpen: Health = {
      ...freshHealth(NOW),
      state: "half-open",
      consecutiveQualityFailures: 5,
      openedAt: NOW,
      cooldownEndsAt: NOW - 1,
    };
    const next = recordSuccess(halfOpen, NOW + 1);
    expect(next.state).toBe("closed");
    expect(next.consecutiveQualityFailures).toBe(0);
  });

  it("preserves closed state on success and zeroes counter", () => {
    const closed: Health = { ...freshHealth(NOW), consecutiveQualityFailures: 3 };
    const next = recordSuccess(closed, NOW + 1);
    expect(next.state).toBe("closed");
    expect(next.consecutiveQualityFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filesystem persistence — uses a real tmpdir per test
// ---------------------------------------------------------------------------

describe("persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-ph-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("healthFilePath is <repo>/.dragnet/provider-health.json", () => {
    expect(healthFilePath("/repo/x")).toBe(path.join("/repo", "x", ".dragnet", "provider-health.json"));
  });

  it("healthFilePath uses central path when repoId provided", () => {
    expect(healthFilePath("/repo/x", "repo-123")).toBe(
      path.join("/var/lib/dragnet/scans", "repo-123", "provider-health.json"),
    );
  });

  it("readHealthFile returns empty when file missing", () => {
    expect(readHealthFile(tmpDir)).toEqual({ providers: {} });
  });

  it("readHealthFile returns empty when JSON corrupt", () => {
    fs.mkdirSync(path.join(tmpDir, ".dragnet"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".dragnet", "provider-health.json"), "{ not json", "utf8");
    expect(readHealthFile(tmpDir)).toEqual({ providers: {} });
  });

  it("write+read round trip with repoId writes to central path", () => {
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-ph-root-"));
    process.env.DRAGNET_SCAN_STATE_ROOT = scanRoot;
    const now = Date.now();
    const file: ProviderHealthFile = {
      providers: {
        "openrouter.ai:gpt-5": {
          consecutiveQualityFailures: 1,
          openedAt: null,
          cooldownEndsAt: null,
          state: "closed",
          updatedAt: now,
          presetName: "OpenRouter",
        },
      },
    };
    writeHealthFile(tmpDir, file, "repo-central");
    const centralPath = path.join(scanRoot, "repo-central", "provider-health.json");
    expect(fs.existsSync(centralPath)).toBe(true);
    // Legacy path should NOT have the file.
    expect(fs.existsSync(path.join(tmpDir, ".dragnet", "provider-health.json"))).toBe(false);
    // Read back from central path.
    const back = readHealthFile(tmpDir, "repo-central");
    expect(back.providers["openrouter.ai:gpt-5"].consecutiveQualityFailures).toBe(1);
    // Clean up.
    delete process.env.DRAGNET_SCAN_STATE_ROOT;
    fs.rmSync(scanRoot, { recursive: true, force: true });
  });

  it("write+read round trip preserves one record", () => {
    const now = Date.now();
    const file: ProviderHealthFile = {
      providers: {
        "openrouter.ai:gpt-5": {
          consecutiveQualityFailures: 2,
          openedAt: null,
          cooldownEndsAt: null,
          state: "closed",
          updatedAt: now,
          presetName: "OpenRouter",
        },
      },
    };
    writeHealthFile(tmpDir, file);
    const back = readHealthFile(tmpDir);
    expect(back.providers["openrouter.ai:gpt-5"]).toEqual(file.providers["openrouter.ai:gpt-5"]);
  });

  it("writeHealthFile writes at mode 0600", () => {
    writeHealthFile(tmpDir, { providers: {} });
    const stat = fs.statSync(path.join(tmpDir, ".dragnet", "provider-health.json"));
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writeHealthFile does not leave a .tmp file behind", () => {
    writeHealthFile(tmpDir, { providers: {} });
    const entries = fs.readdirSync(path.join(tmpDir, ".dragnet"));
    expect(entries).toEqual(["provider-health.json"]);
  });

  it("sequential writes overwrite cleanly", () => {
    const key = "openrouter.ai:gpt-5";
    recordProviderQualityFailure(tmpDir, "https://openrouter.ai/api/v1", "gpt-5", "OpenRouter");
    recordProviderQualityFailure(tmpDir, "https://openrouter.ai/api/v1", "gpt-5", "OpenRouter");
    let back = readHealthFile(tmpDir);
    expect(back.providers[key].consecutiveQualityFailures).toBe(2);

    recordProviderSuccess(tmpDir, "https://openrouter.ai/api/v1", "gpt-5", "OpenRouter");
    back = readHealthFile(tmpDir);
    expect(back.providers[key].consecutiveQualityFailures).toBe(0);
    expect(back.providers[key].state).toBe("closed");
  });

  it("getProviderHealth returns live state, including half-open promotion", () => {
    const endpoint = "https://openrouter.ai/api/v1";
    const model = "gpt-5";
    // Force open with cooldown in the past.
    const now = Date.now();
    const file: ProviderHealthFile = {
      providers: {
        [breakerKeyFor(endpoint, model)]: {
          consecutiveQualityFailures: 5,
          openedAt: now - 10_000,
          cooldownEndsAt: now - 1, // expired
          state: "open",
          updatedAt: now,
        },
      },
    };
    writeHealthFile(tmpDir, file);
    const { state, health } = getProviderHealth(tmpDir, endpoint, model);
    expect(state).toBe("half-open");
    expect(health).not.toBeNull();
  });

  it("listProviderHealth returns full snapshot", () => {
    recordProviderQualityFailure(tmpDir, "https://x.com/v1", "m1", "P1");
    recordProviderQualityFailure(tmpDir, "https://y.com/v1", "m2", "P2");
    const snap = listProviderHealth(tmpDir);
    expect(Object.keys(snap.providers).sort()).toEqual(["x.com:m1", "y.com:m2"]);
  });

  it("resetProviderHealth with no args clears everything", () => {
    recordProviderQualityFailure(tmpDir, "https://x.com/v1", "m1", "P1");
    recordProviderQualityFailure(tmpDir, "https://y.com/v1", "m2", "P2");
    resetProviderHealth(tmpDir);
    expect(readHealthFile(tmpDir)).toEqual({ providers: {} });
  });

  it("resetProviderHealth with key removes only that key", () => {
    recordProviderQualityFailure(tmpDir, "https://x.com/v1", "m1", "P1");
    recordProviderQualityFailure(tmpDir, "https://y.com/v1", "m2", "P2");
    resetProviderHealth(tmpDir, "https://x.com/v1", "m1");
    const back = readHealthFile(tmpDir);
    expect(Object.keys(back.providers)).toEqual(["y.com:m2"]);
  });
});

// ---------------------------------------------------------------------------
// No-repoPath degradation
// ---------------------------------------------------------------------------

describe("missing repoPath", () => {
  it("recordProviderQualityFailure is a no-op (no exception)", () => {
    expect(() => recordProviderQualityFailure(null, "https://x.com/v1", "m1")).not.toThrow();
    expect(() => recordProviderQualityFailure(undefined, "https://x.com/v1", "m1")).not.toThrow();
  });

  it("recordProviderSuccess is a no-op (no exception)", () => {
    expect(() => recordProviderSuccess(null, "https://x.com/v1", "m1")).not.toThrow();
  });

  it("getProviderHealth returns closed state, null health", () => {
    const { state, health } = getProviderHealth(null, "https://x.com/v1", "m1");
    expect(state).toBe("closed");
    expect(health).toBeNull();
  });

  it("listProviderHealth returns empty", () => {
    expect(listProviderHealth(null)).toEqual({ providers: {} });
  });

  it("resetProviderHealth is a no-op", () => {
    expect(() => resetProviderHealth(null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Concurrency documentation — behavior verification, not a true race
// ---------------------------------------------------------------------------

describe("concurrency note", () => {
  // Phase 3 explicitly accepts read-modify-write races under concurrent
  // scans. This test documents the contract: a lost increment is the
  // worst case. Do not add file locks or DB locks in this phase.
  it("two sequential recordQualityFailure calls both persist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-ph-"));
    try {
      recordProviderQualityFailure(tmpDir, "https://x.com/v1", "m1", "P1");
      recordProviderQualityFailure(tmpDir, "https://x.com/v1", "m1", "P1");
      const back = readHealthFile(tmpDir);
      expect(back.providers["x.com:m1"].consecutiveQualityFailures).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
