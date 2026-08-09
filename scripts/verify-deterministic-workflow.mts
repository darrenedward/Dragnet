import { createDisposableServicePlan } from "../src/services/deterministicChecks/disposableServices";
import { resolveToolchain, type Ecosystem, type TipTreeManifest, type ToolchainStatus } from "../src/services/deterministicChecks/toolchainResolver";

type Fingerprint = string & { readonly __sha256: true };

export interface VerificationCase {
  readonly name: string;
  readonly ecosystem: Ecosystem;
  readonly files: Readonly<Record<string, string>>;
  readonly requiresService?: string;
}

export interface VerificationResult {
  readonly name: string;
  readonly ecosystem: Ecosystem;
  readonly status: ToolchainStatus;
  readonly fingerprint: Fingerprint;
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

function createTipManifest(files: Readonly<Record<string, string>>): TipTreeManifest {
  return { headSha: "verification-fixture".padEnd(40, "0"), source: "pr-tip", files };
}

export function verifyLocalMatrix(): readonly VerificationResult[] {
  return VERIFICATION_MATRIX.map((fixture) => {
    const result = resolveToolchain({ tip: createTipManifest(fixture.files) });
    if (result.identity?.ecosystem !== fixture.ecosystem) throw new Error(`${fixture.name}: expected ${fixture.ecosystem}, got ${result.identity?.ecosystem ?? "none"}`);
    if (result.status !== "resolved") throw new Error(`${fixture.name}: ${result.status} — ${result.conflicts.join("; ")}`);
    if (fixture.requiresService) {
      const servicePlan = createDisposableServicePlan(`verification-${fixture.name}`, [{
        name: fixture.requiresService,
        image: "postgres:16.4",
        alias: "db",
        healthcheck: { command: ["pg_isready"] },
      }]);
      if (servicePlan.services[0]?.alias !== "db") throw new Error(`${fixture.name}: service plan was not created`);
    }
    return { name: fixture.name, ecosystem: fixture.ecosystem, status: result.status, fingerprint: result.fingerprint as Fingerprint };
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
