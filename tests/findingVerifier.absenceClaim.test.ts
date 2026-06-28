import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { verifyFindings, type CandidateFinding } from "../src/services/findingVerifier";

/**
 * Stage A.5 — absence-claim verifier tests.
 *
 * Catches the failure mode where the LLM reviewer claims a file/route/
 * import does not exist or is unused, but the filesystem contradicts it.
 *
 * Three real-world failure modes this guards against (from a DevWorld
 * skills PR review):
 *   - B3: reviewer claimed `/api/skills/import-pack/route.ts` did not
 *     exist. It does.
 *   - S3: reviewer claimed `js-yaml` was unused. It's imported.
 *   - (Correct absence): a real missing file must NOT be rejected.
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-absence-"));

  // Simulate the DevWorld layout that triggered the original false
  // positives. Test asserts the verifier catches them deterministically.
  fs.mkdirSync(path.join(tmpDir, "src/app/api/skills/import-pack"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "src/lib/skills"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, "src/app/api/skills/import-pack/route.ts"),
    [
      "import { NextResponse } from 'next/server';",
      "export async function POST(req: Request) {",
      "  return NextResponse.json({ ok: true });",
      "}",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(tmpDir, "src/lib/skills/manifest-parser.ts"),
    [
      "import yaml from 'js-yaml';",
      "export function parse(src: string) {",
      "  return yaml.load(src);",
      "}",
    ].join("\n"),
  );

  // Call site that the B3 finding cites as its filename. The reviewer's
  // mistake is in the explanation ("route does not exist"), not in the
  // file citation — Stage A must pass so Stage A.5 can run.
  fs.writeFileSync(
    path.join(tmpDir, "src/lib/skillsClient.ts"),
    [
      "export async function importPack(pack: string) {",
      "  const res = await fetch('/api/skills/import-pack', {",
      "    method: 'POST',",
      "    body: JSON.stringify({ pack }),",
      "  });",
      "  return res.json();",
      "}",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ dependencies: { "js-yaml": "^5.2.0" } }, null, 2),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function finding(opts: Partial<CandidateFinding> & { id: string }): CandidateFinding {
  return {
    category: "Bug",
    severity: "high",
    filename: "src/app/api/skills/import-pack/route.ts",
    line: 1,
    explanation: "",
    ...opts,
  };
}

describe("findingVerifier Stage A.5 — absence claims", () => {
  it("rejects 'missing route' claim when the route file exists", async () => {
    // B3-shaped: reviewer cited the URL in prose, not the file path.
    // Verifier extracts /api/skills/import-pack, converts to Next.js
    // route handler path, finds it, rejects.
    const results = await verifyFindings(
      [finding({
        id: "b3",
        filename: "src/lib/skillsClient.ts",
        line: 1,
        explanation:
          "The route POST /api/skills/import-pack does not exist. There is no handler — clients will get a 404.",
      })],
      tmpDir,
      "test-pr",
    );
    const v = results.get("b3");
    expect(v?.status).toBe("rejected");
    expect(v?.note).toMatch(/absence_claim_contradicted_by_fs/);
    expect(v?.note).toMatch(/import-pack/);
  });

  it("rejects 'unused import' claim when grep finds the symbol", async () => {
    // S3-shaped: reviewer claims js-yaml is unused. It's imported in
    // src/lib/skills/manifest-parser.ts. Verifier greps the repo,
    // finds the import, rejects.
    const results = await verifyFindings(
      [finding({
        id: "s3",
        category: "Bug",
        severity: "medium",
        filename: "package.json",
        line: 1,
        explanation:
          'The "js-yaml" dependency is an unused import — it is never imported anywhere in the codebase, so it should be removed.',
      })],
      tmpDir,
      "test-pr",
    );
    const v = results.get("s3");
    expect(v?.status).toBe("rejected");
    expect(v?.note).toMatch(/absence_claim_contradicted_by_fs/);
    expect(v?.note).toMatch(/js-yaml/);
    expect(v?.note).toMatch(/manifest-parser\.ts/);
  });

  it("does NOT reject a correct absence claim (file genuinely missing)", async () => {
    // Correct absence: cited file truly doesn't exist. Verifier should
    // either return verified or fall through to Stage B (status other
    // than rejected with no absence_claim_contradicted_by_fs note).
    const results = await verifyFindings(
      [finding({
        id: "correct-absence",
        filename: "src/lib/skills/manifest-parser.ts",
        line: 1,
        explanation:
          'The handler references "src/lib/bar.ts" but this file does not exist.',
      })],
      tmpDir,
      "test-pr",
    );
    const v = results.get("correct-absence");
    expect(v).toBeDefined();
    expect(v?.note).not.toMatch(/absence_claim_contradicted_by_fs/);
  });

  it("falls through when no absence phrase is present", async () => {
    // Plain correctness finding — no absence claim. Stage A.5 returns
    // null, Stage B / line-validation decides the verdict.
    const results = await verifyFindings(
      [finding({
        id: "no-claim",
        category: "Performance",
        severity: "warning",
        filename: "src/lib/skills/manifest-parser.ts",
        line: 3,
        explanation: "yaml.load is called on every request — cache the parsed result.",
      })],
      tmpDir,
      "test-pr",
    );
    const v = results.get("no-claim");
    expect(v).toBeDefined();
    // The exact verdict depends on Stage A/B, but it must not be an
    // absence-claim rejection (no absence phrase matched).
    expect(v?.note).not.toMatch(/absence_claim_contradicted_by_fs/);
  });
});
