import { resolveToolchain, type Ecosystem, type TipTreeManifest } from "../src/services/deterministicChecks/toolchainResolver";

export interface VerificationCase {
  readonly name: string;
  readonly ecosystem: Ecosystem;
  readonly files: Readonly<Record<string, string>>;
  readonly requiresService?: string;
}

export const VERIFICATION_MATRIX: readonly VerificationCase[] = [
  {
    name: "node-pnpm",
    ecosystem: "node",
    files: {
      "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", scripts: { test: "pnpm test" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    },
  },
  { name: "python-uv", ecosystem: "python", files: { "pyproject.toml": "[project]\nname='fixture'\n", "uv.lock": "version = 1\n" } },
  { name: "go", ecosystem: "go", files: { "go.mod": "module example.com/fixture\ngo 1.22\n", "go.sum": "" } },
  { name: "rust", ecosystem: "rust", files: { "Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n", "Cargo.lock": "version = 3\n" } },
  {
    name: "node-pnpm-service-backed",
    ecosystem: "node",
    requiresService: "postgres",
    files: {
      "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", scripts: { integration: "pnpm test:integration" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    },
  },
];

function tip(files: Readonly<Record<string, string>>): TipTreeManifest {
  return { headSha: "verification-fixture".padEnd(40, "0"), source: "pr-tip", files };
}

export function verifyLocalMatrix(): readonly { name: string; ecosystem: Ecosystem; status: string; fingerprint: string }[] {
  return VERIFICATION_MATRIX.map((fixture) => {
    const result = resolveToolchain({ tip: tip(fixture.files) });
    if (result.identity?.ecosystem !== fixture.ecosystem) throw new Error(`${fixture.name}: expected ${fixture.ecosystem}, got ${result.identity?.ecosystem ?? "none"}`);
    if (result.status !== "resolved") throw new Error(`${fixture.name}: ${result.status} — ${result.conflicts.join("; ")}`);
    return { name: fixture.name, ecosystem: fixture.ecosystem, status: result.status, fingerprint: result.fingerprint };
  });
}

export async function verifyDeployedApi(): Promise<{ url: string; repoCount: number }> {
  const url = process.env.DRAGNET_URL;
  const key = process.env.DRAGNET_REPO_KEY ?? process.env.DRAGNET_API_KEY;
  if (!url || !key) throw new Error("Deployed verification requires DRAGNET_URL and DRAGNET_REPO_KEY/DRAGNET_API_KEY");
  const response = await fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Deployed Dragnet API returned HTTP ${response.status}`);
  const repos = await response.json() as unknown;
  if (!Array.isArray(repos)) throw new Error("Deployed Dragnet API returned an invalid repository list");
  return { url, repoCount: repos.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const matrix = verifyLocalMatrix();
  const deployed = process.argv.includes("--deployed") ? await verifyDeployedApi() : null;
  console.log(JSON.stringify({ matrix, deployed }, null, 2));
}
