import { createHash } from "node:crypto";

export type ToolchainStatus = "resolved" | "ambiguous" | "unsupported";
export type Ecosystem = "node" | "python" | "go" | "rust" | "ruby" | "php";

export interface TipTreeManifest {
  readonly headSha: string;
  /** `remote-volume` means the provider tip was synced into the runner volume. */
  readonly source: "pr-tip" | "remote-volume" | "host-checkout";
  readonly files: Readonly<Record<string, string>>;
}

export interface ToolchainConfiguration {
  readonly workspace?: string;
  readonly qualityCommands?: readonly string[];
}

export interface ProjectIdentity {
  readonly ecosystem: Ecosystem;
  readonly runtime: Readonly<Record<string, string>>;
  readonly lockfiles: readonly string[];
  readonly packageManager?: { readonly name: string; readonly version?: string };
  readonly database: "none";
}

export interface ResolvedToolchain {
  readonly status: ToolchainStatus;
  readonly tip: { readonly headSha: string; readonly source: "pr-tip" | "remote-volume" };
  readonly identity: ProjectIdentity | null;
  readonly configuration: {
    readonly workspace: string;
    readonly qualityCommands: readonly string[];
  };
  readonly execution: {
    readonly image: string | null;
    readonly installCommand: string | null;
    readonly qualityCommands: readonly string[];
  };
  readonly conflicts: readonly string[];
  readonly fingerprint: string;
}

type Detector = {
  ecosystem: Ecosystem;
  declarations: readonly string[];
};

const DETECTORS: readonly Detector[] = [
  { ecosystem: "node", declarations: ["package.json"] },
  { ecosystem: "python", declarations: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"] },
  { ecosystem: "go", declarations: ["go.mod"] },
  { ecosystem: "rust", declarations: ["Cargo.toml"] },
  { ecosystem: "ruby", declarations: ["Gemfile"] },
  { ecosystem: "php", declarations: ["composer.json"] },
];

const IMAGES: Record<Ecosystem, string> = {
  node: "node:20-alpine",
  python: "python:3.12-slim",
  go: "golang:1.22-alpine",
  rust: "rust:1.86-slim",
  ruby: "ruby:3.3-alpine",
  php: "composer:2.8",
};

const LOCKFILES: Record<Ecosystem, readonly string[]> = {
  node: ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"],
  python: ["uv.lock", "poetry.lock", "requirements.txt"],
  go: ["go.sum"],
  rust: ["Cargo.lock"],
  ruby: ["Gemfile.lock"],
  php: ["composer.lock"],
};

const UNSUPPORTED_DECLARATIONS = ["pom.xml", "build.gradle", "mix.exs", "Package.swift"];

function jsonFile(files: Readonly<Record<string, string>>, name: string): Record<string, unknown> {
  try {
    const value = JSON.parse(files[name] ?? "{}");
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasValidJsonObject(files: Readonly<Record<string, string>>, name: string): boolean {
  if (!(name in files)) return true;
  try {
    const value = JSON.parse(files[name]);
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

function declaration(files: Readonly<Record<string, string>>, pattern: RegExp, file: string): string | undefined {
  const match = (files[file] ?? "").match(pattern);
  return match?.[1]?.trim();
}

function packageManager(files: Readonly<Record<string, string>>, lockfiles: readonly string[]): ProjectIdentity["packageManager"] {
  const packageJson = jsonFile(files, "package.json");
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager : undefined;
  const match = declared?.match(/^(npm|pnpm|yarn)@(.+)$/);
  if (match) return { name: match[1], version: match[2] };
  if (lockfiles.includes("pnpm-lock.yaml")) return { name: "pnpm" };
  if (lockfiles.includes("yarn.lock")) return { name: "yarn" };
  if (lockfiles.includes("package-lock.json") || lockfiles.includes("npm-shrinkwrap.json")) return { name: "npm" };
  return { name: "npm" };
}

function runtimeFor(
  ecosystem: Ecosystem,
  files: Readonly<Record<string, string>>,
  packageJson: Record<string, unknown>,
): Readonly<Record<string, string>> {
  if (ecosystem === "node") {
    const engines = isRecord(packageJson.engines) ? packageJson.engines : undefined;
    const node = typeof engines?.node === "string" ? engines.node : undefined;
    const version = declaration(files, /^\s*(?:v)?([^\s#]+)\s*$/m, ".nvmrc")
      ?? declaration(files, /^\s*(?:v)?([^\s#]+)\s*$/m, ".node-version");
    return node || version ? { ...(node ? { node } : {}), ...(version ? { nodeFile: version } : {}) } : {};
  }
  if (ecosystem === "python") {
    const python = declaration(files, /^\s*requires-python\s*=\s*["']([^"']+)["']/m, "pyproject.toml");
    return python ? { python } : {};
  }
  if (ecosystem === "go") {
    const go = declaration(files, /^\s*go\s+([^\s]+)\s*$/m, "go.mod");
    return go ? { go } : {};
  }
  if (ecosystem === "rust") {
    const rust = declaration(files, /^\s*channel\s*=\s*["']([^"']+)["']/m, "rust-toolchain.toml")
      ?? declaration(files, /^\s*([^\s#]+)\s*$/m, "rust-toolchain");
    return rust ? { rust } : {};
  }
  if (ecosystem === "ruby") {
    const ruby = declaration(files, /^\s*([^\s#]+)\s*$/m, ".ruby-version");
    return ruby ? { ruby } : {};
  }
  const php = declaration(files, /["']php["']\s*:\s*["']([^"']+)["']/m, "composer.json");
  return php ? { php } : {};
}

function qualityCommands(
  ecosystem: Ecosystem,
  files: Readonly<Record<string, string>>,
  config: ToolchainConfiguration | undefined,
): readonly string[] {
  if (config?.qualityCommands) return [...config.qualityCommands];
  if (ecosystem === "node") {
    const scriptsValue = jsonFile(files, "package.json").scripts;
    const scripts = isRecord(scriptsValue) ? scriptsValue : undefined;
    return ["build", "typecheck", "lint", "test"]
      .map((name) => typeof scripts?.[name] === "string" ? scripts[name] : undefined)
      .filter((command): command is string => Boolean(command));
  }
  return ecosystem === "python" ? ["python -m pytest"] : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(isRecord(value) ? value : {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withFingerprint(
  result: Omit<ResolvedToolchain, "fingerprint">,
  tipFiles: Readonly<Record<string, string>> = {},
): ResolvedToolchain {
  const fingerprintInput = { ...result, tipFiles: Object.fromEntries(Object.entries(tipFiles).sort(([a], [b]) => a.localeCompare(b))) };
  const fingerprint = createHash("sha256").update(canonical(fingerprintInput)).digest("hex");
  return { ...result, fingerprint };
}

export function resolveToolchain(input: {
  tip: TipTreeManifest;
  configuration?: ToolchainConfiguration;
}): ResolvedToolchain {
  const { tip, configuration } = input;
  if (tip.source === "host-checkout") {
    throw new Error("Toolchain resolution requires the PR tip tree; host checkout is not valid");
  }
  const files = Object.fromEntries(Object.entries(tip.files).map(([path, content]) => [path.replace(/^\.\//, ""), content]));
  const detectors = DETECTORS.filter((detector) => detector.declarations.some((file) => file in files));
  const resolvedConfiguration = {
    workspace: configuration?.workspace ?? ".",
    qualityCommands: configuration?.qualityCommands ? [...configuration.qualityCommands] : [],
  };
  const tipInfo = { headSha: tip.headSha, source: tip.source } as const;

  if (detectors.length === 0) {
    const unsupported = UNSUPPORTED_DECLARATIONS.find((file) => file in files);
    return withFingerprint({
      status: "unsupported",
      tip: tipInfo,
      identity: null,
      configuration: resolvedConfiguration,
      execution: { image: null, installCommand: null, qualityCommands: [] },
      conflicts: [unsupported ? `Unsupported project declaration: ${unsupported}` : "No supported project declaration found in the PR tip tree"],
    }, files);
  }

  const ecosystem = detectors[0].ecosystem;
  const conflicts: string[] = [];
  if (detectors.length > 1) conflicts.push(`Multiple project ecosystems detected: ${detectors.map((item) => item.ecosystem).join(", ")}`);
  const lockfiles = LOCKFILES[ecosystem].filter((file) => file in files);
  if (lockfiles.length > 1) conflicts.push(`Multiple ${ecosystem === "node" ? "Node" : ecosystem} lockfiles detected`);
  if (resolvedConfiguration.workspace !== "." && !(`${resolvedConfiguration.workspace}/package.json` in files || resolvedConfiguration.workspace in files)) {
    conflicts.push(`Configured workspace does not exist in the PR tip tree: ${resolvedConfiguration.workspace}`);
  }

  const packageJson = jsonFile(files, "package.json");
  const runtime = runtimeFor(ecosystem, files, packageJson);
  if (ecosystem === "node" && runtime.node && runtime.nodeFile && runtime.node !== runtime.nodeFile) {
    conflicts.push(`Node runtime declarations conflict: engines.node=${runtime.node} vs version file=${runtime.nodeFile}`);
  }
  if (ecosystem === "node" && !hasValidJsonObject(files, "package.json")) {
    conflicts.push("package.json is not valid JSON");
  }
  const declaredManager = typeof packageJson.packageManager === "string" ? packageJson.packageManager.split("@")[0] : undefined;
  if (declaredManager && ecosystem === "node" && lockfiles.length === 1) {
    const lockManager = lockfiles[0] === "pnpm-lock.yaml" ? "pnpm" : lockfiles[0] === "yarn.lock" ? "yarn" : "npm";
    if (declaredManager !== lockManager) conflicts.push(`packageManager declares ${declaredManager} but ${lockfiles[0]} requires ${lockManager}`);
  }
  const manager = ecosystem === "node" ? packageManager(files, lockfiles) : undefined;
  const installCommand = ecosystem === "node" && lockfiles.length === 0 ? null
    : ecosystem === "node"
      ? manager?.name === "pnpm" ? "corepack pnpm install --frozen-lockfile"
        : manager?.name === "yarn" ? "corepack yarn install --immutable"
          : "npm ci"
    : ecosystem === "python" && lockfiles.includes("uv.lock") ? "uv sync --locked"
      : ecosystem === "python" && lockfiles.includes("poetry.lock") ? "poetry install --no-root"
        : ecosystem === "python" && lockfiles.includes("requirements.txt") ? "python -m pip install -r requirements.txt"
          : ecosystem === "python" ? null
        : ecosystem === "go" ? "go mod download"
          : ecosystem === "rust" ? "cargo check --locked"
            : ecosystem === "ruby" ? "bundle install --deployment"
              : "composer install --no-interaction --prefer-dist --no-progress";
  const identity: ProjectIdentity = {
    ecosystem,
    runtime,
    lockfiles,
    ...(manager ? { packageManager: manager } : {}),
    database: "none",
  };
  if (ecosystem === "node" && lockfiles.length === 0) conflicts.push("No Node lockfile detected; deterministic install cannot use npm ci");
  if (ecosystem === "python" && lockfiles.length === 0) conflicts.push("No Python dependency lockfile detected");
  const checks = qualityCommands(ecosystem, files, configuration);
  return withFingerprint({
    status: conflicts.length > 0 ? "ambiguous" : "resolved",
    tip: tipInfo,
    identity,
    configuration: resolvedConfiguration,
    execution: { image: IMAGES[ecosystem], installCommand, qualityCommands: checks },
    conflicts,
  }, files);
}
