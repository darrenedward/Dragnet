import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureReviewTree,
  resolveCommitIdentity,
} from "../src/lib/reviewTree";
import {
  ensureTipOverlay,
  searchTipOverlay,
  getTipOverlayCallers,
  findTipOverlaySimilar,
  isTipOverlayFresh,
  assertTipOverlayFresh,
  formatTipOverlayLog,
  extractRelativeImportSpecs,
  resolveImportCandidates,
  mergeSymbolSearchResults,
  makeOverlaySymbolId,
} from "../src/lib/tipOverlay";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): {
  root: string;
  mainSha: string;
  tipSha: string;
  baseSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dragnet-tip-overlay-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "test@dragnet.local"]);
  git(root, ["config", "user.name", "Test"]);

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "mainOnly.ts"),
    `export function mainOnlyHelper() { return 1; }\n`,
  );
  writeFileSync(
    join(root, "src", "shared.ts"),
    `export function sharedFn() { return "main"; }\n`,
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "main base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  const mainSha = baseSha;

  git(root, ["checkout", "-q", "-b", "feature/tip"]);
  writeFileSync(
    join(root, "src", "shared.ts"),
    `export function sharedFn() { return "tip"; }\nexport function tipSharedExtra() { return 2; }\n`,
  );
  // Tip-only file with a unique symbol name — must be searchable after overlay.
  writeFileSync(
    join(root, "src", "tipOnly.ts"),
    `import { sharedFn } from "./shared";\n\nexport function brandNewTipSymbol() {\n  return sharedFn();\n}\n\nexport function callsBrandNew() {\n  return brandNewTipSymbol();\n}\n`,
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "tip changes"]);
  const tipSha = git(root, ["rev-parse", "HEAD"]);

  // Host stays on main — ambient disk must not be the tip source.
  git(root, ["checkout", "-q", "main"]);
  expect(readFileSync(join(root, "src", "shared.ts"), "utf8")).toContain('"main"');
  expect(() => readFileSync(join(root, "src", "tipOnly.ts"), "utf8")).toThrow();

  return { root, mainSha, tipSha, baseSha };
}

describe("extractRelativeImportSpecs / resolveImportCandidates", () => {
  it("extracts relative imports", () => {
    const code = `import { a } from "./shared";\nexport { b } from "../other";\nconst x = require("./x");\n`;
    expect(extractRelativeImportSpecs(code)).toEqual(
      expect.arrayContaining(["./shared", "../other", "./x"]),
    );
  });

  it("resolves candidates with extensions", () => {
    const c = resolveImportCandidates("src/tipOnly.ts", "./shared");
    expect(c).toContain("src/shared.ts");
  });
});

describe("assertTipOverlayFresh / isTipOverlayFresh", () => {
  it("requires overlay matching head (not main-volume identity)", () => {
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(isTipOverlayFresh(null, head)).toBe(false);
    const missing = assertTipOverlayFresh(null, head);
    expect(missing.ok).toBe(false);
    if (missing.ok === false) {
      expect(missing.kind).toBe("OVERLAY_REQUIRED");
    }

    const overlay = {
      headSha: other,
      repoId: "r1",
      filePaths: [] as string[],
      symbols: [] as [],
      edges: [] as [],
      builtAt: 1,
    };
    expect(isTipOverlayFresh(overlay, head)).toBe(false);
    const stale = assertTipOverlayFresh(overlay, head);
    expect(stale.ok).toBe(false);
    if (stale.ok === false) expect(stale.kind).toBe("OVERLAY_STALE");

    const fresh = { ...overlay, headSha: head };
    expect(isTipOverlayFresh(fresh, head)).toBe(true);
    expect(assertTipOverlayFresh(fresh, head)).toEqual({ ok: true });
  });
});

describe("mergeSymbolSearchResults", () => {
  it("prefers tip hits over base for the same path+name", () => {
    const merged = mergeSymbolSearchResults(
      [
        {
          id: "tip-1",
          name: "foo",
          kind: "function",
          filePath: "a.ts",
          lineStart: 1,
          lineEnd: 2,
          source: "tip",
        },
      ],
      [
        {
          id: "base-1",
          name: "foo",
          kind: "function",
          filePath: "a.ts",
          lineStart: 1,
          lineEnd: 2,
          source: "base",
        },
        {
          id: "base-2",
          name: "bar",
          kind: "function",
          filePath: "b.ts",
          lineStart: 1,
          lineEnd: 2,
          source: "base",
        },
      ],
      10,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("tip-1");
    expect(merged[0].source).toBe("tip");
    expect(merged[1].id).toBe("base-2");
  });
});

describe("ensureTipOverlay — tip-only symbols searchable after prelude", () => {
  let root: string;
  let tipSha: string;
  let baseSha: string;

  beforeEach(() => {
    const r = initRepo();
    root = r.root;
    tipSha = r.tipSha;
    baseSha = r.baseSha;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("indexes tip-only file/symbol via tip tree while host is on main", async () => {
    const identity = await resolveCommitIdentity(
      { id: "r1", path: root, baseBranch: "main" },
      {
        commitHash: tipSha,
        sourceBranch: "feature/tip",
        targetBranch: "main",
      },
    );
    expect(identity.headSha).toBe(tipSha);

    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: identity.headSha,
      baseSha: identity.baseSha || baseSha,
    });

    // Ambient disk still main — tipOnly.ts absent.
    expect(() => readFileSync(join(root, "src", "tipOnly.ts"), "utf8")).toThrow();

    const overlay = await ensureTipOverlay({
      repoId: "repo-tip",
      headSha: identity.headSha,
      changedFiles: ["src/tipOnly.ts", "src/shared.ts"],
      readFile: (p) => tree.readFile(p),
    });

    expect(isTipOverlayFresh(overlay, tipSha)).toBe(true);
    expect(assertTipOverlayFresh(overlay, tipSha)).toEqual({ ok: true });
    // Volume-on-main must not make tools think index is tip-ready without overlay.
    expect(assertTipOverlayFresh(overlay, baseSha).ok).toBe(false);

    const log = formatTipOverlayLog(overlay);
    expect(log).toContain(tipSha);
    expect(log).toMatch(/symbols=\d+/);

    // AC: tip-only symbol findable via search after overlay
    const hits = searchTipOverlay(overlay, "brandNewTipSymbol");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe("brandNewTipSymbol");
    expect(hits[0].filePath).toBe("src/tipOnly.ts");

    // Neighbor import target was also parsed at tip
    const shared = searchTipOverlay(overlay, "sharedFn");
    expect(shared.some((s) => s.filePath === "src/shared.ts")).toBe(true);

    // Callers prefer tip-generation edges for tip names
    const brand = hits[0];
    const callers = getTipOverlayCallers(overlay, brand.id);
    expect(callers.some((c) => c.callerName === "callsBrandNew")).toBe(true);

    const similar = findTipOverlaySimilar(overlay, "brandNewTipSymbol");
    expect(similar.some((s) => s.name === "brandNewTipSymbol")).toBe(true);

    // makeOverlaySymbolId is stable
    const id2 = makeOverlaySymbolId("repo-tip", brand.filePath, {
      kind: brand.kind,
      name: brand.name,
      lineStart: brand.lineStart,
    });
    expect(id2).toBe(brand.id);
  });

  it("does not invent tip-only symbols when reading empty tip paths", async () => {
    const overlay = await ensureTipOverlay({
      repoId: "r2",
      headSha: tipSha,
      changedFiles: ["src/does-not-exist.ts"],
      readFile: async () => null,
    });
    expect(overlay.symbols).toHaveLength(0);
    expect(searchTipOverlay(overlay, "brandNewTipSymbol")).toHaveLength(0);
    expect(isTipOverlayFresh(overlay, tipSha)).toBe(true);
  });
});
