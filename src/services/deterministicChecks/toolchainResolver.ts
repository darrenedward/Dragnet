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
  /** Explicit package directories to check. Identity is still detected at the root. */
  readonly workspaces?: readonly string[];
  readonly checks?: Partial<Record<CheckKind, readonly QualityCommandConfiguration[]>>;
}

export type CheckKind = "static" | "unit" | "integration" | "e2e";

export interface QualityCommandConfiguration {
  readonly command: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly buildTimeEnvironment?: readonly string[];
  readonly requiresServices?: readonly string[];
  readonly optional?: boolean;
}

export interface ResolvedQualityCommand {
  readonly kind: CheckKind;
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly buildTimeEnvironment: readonly string[];
  readonly requiresServices: readonly string[];
  readonly optional: boolean;
}

export interface ResolvedWorkspace {
  readonly path: string;
  readonly installRoot: string;
  readonly commands: Readonly<Record<CheckKind, readonly ResolvedQualityCommand[]>>;
}

export interface ToolchainRepositoryOverrides {
  readonly runnerImage?: string | null;
  readonly installCommand?: string | null;
}

export interface TipTreeReader {
  readonly headSha: string;
  readonly source: Exclude<TipTreeManifest["source"], "host-checkout">;
  readonly readFile: (path: string) => Promise<string | null>;
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
    readonly workspaces?: readonly string[];
    readonly checks?: Partial<Record<CheckKind, readonly QualityCommandConfiguration[]>>;
  };
  readonly execution: {
    readonly image: string | null;
    readonly installCommand: string | null;
    readonly qualityCommands: readonly string[];
    readonly checks: Readonly<Record<CheckKind, readonly ResolvedQualityCommand[]>>;
    readonly workspaces: readonly ResolvedWorkspace[];
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

export const TOOLCHAIN_MANIFEST_FILES = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  ".nvmrc", ".node-version", "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml",
  "Gemfile", "Gemfile.lock", ".ruby-version", "composer.json", "composer.lock",
] as const;

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
  return {
    python: ["python -m pytest"],
    go: ["go test ./..."],
    rust: ["cargo test --locked"],
    ruby: ["bundle exec ruby -Itest"],
    php: ["composer check-platform-reqs"],
    node: [],
  }[ecosystem];
}

function runtimeImage(ecosystem: Ecosystem, runtime: Readonly<Record<string, string>>): string {
  const declaration = runtime.node ?? runtime.nodeFile ?? runtime.python ?? runtime.go ?? runtime.rust ?? runtime.ruby ?? runtime.php;
  const upperBound = declaration?.match(/^<\s*(\d+)/)?.[1];
  const version = upperBound
    ? (Number(upperBound) >= 20 ? "18" : String(Math.max(16, Number(upperBound) - 1)))
    : declaration?.match(/(?:^|[<>=~^ ])(\d+(?:\.\d+)?)/)?.[1];
  if (!version) return IMAGES[ecosystem];
  if (ecosystem === "node") return `node:${version}-alpine`;
  if (ecosystem === "python") return `python:${version}-slim`;
  if (ecosystem === "go") return `golang:${version}-alpine`;
  if (ecosystem === "rust") return `rust:${version}-slim`;
  if (ecosystem === "ruby") return `ruby:${version}-alpine`;
  return IMAGES[ecosystem];
}

const EMPTY_CHECKS: Readonly<Record<CheckKind, readonly ResolvedQualityCommand[]>> = {
  static: [], unit: [], integration: [], e2e: [],
};

function checkKindForScript(name: string): CheckKind {
  if (/e2e|playwright|cypress/i.test(name)) return "e2e";
  if (/integration|contract/i.test(name)) return "integration";
  if (/test|unit|vitest|jest/i.test(name)) return "unit";
  return "static";
}

function packageDirectories(files: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.keys(files)
    .filter((file) => file.endsWith("/package.json"))
    .map((file) => file.slice(0, -"/package.json".length)))]
    .filter(Boolean)
    .sort();
}

function packageWorkspaces(files: Readonly<Record<string, string>>, config: ToolchainConfiguration | undefined): string[] {
  if (config?.workspaces) return [...new Set(config.workspaces)].sort();
  if (config?.workspace && config.workspace !== ".") return [config.workspace];
  const root = jsonFile(files, "package.json");
  const declared = Array.isArray(root.workspaces)
    ? root.workspaces.filter((item): item is string => typeof item === "string")
    : isRecord(root.workspaces) && Array.isArray(root.workspaces.packages)
      ? root.workspaces.packages.filter((item): item is string => typeof item === "string")
      : [];
  const candidates = packageDirectories(files);
  if (declared.length === 0) return ["."];
  const prefixes = declared.map((pattern) => pattern.replace(/\*.*$/, "").replace(/\/$/, ""));
  return [".", ...candidates.filter((path) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))];
}

function checksForWorkspace(
  files: Readonly<Record<string, string>>,
  workspace: string,
  config: ToolchainConfiguration | undefined,
): Readonly<Record<CheckKind, readonly ResolvedQualityCommand[]>> {
  const packagePath = workspace === "." ? "package.json" : `${workspace}/package.json`;
  const scriptsValue = jsonFile(files, packagePath).scripts;
  const scripts = isRecord(scriptsValue) ? scriptsValue : {};
  const result: Record<CheckKind, ResolvedQualityCommand[]> = { static: [], unit: [], integration: [], e2e: [] };
  if (config?.qualityCommands && workspace === (config.workspace ?? ".")) {
    result.static = config.qualityCommands.map((command) => ({
      kind: "static", command, cwd: workspace, environment: {}, buildTimeEnvironment: [], requiresServices: [], optional: false,
    }));
    return result;
  }
  const configured = config?.checks;
  if (configured) {
    for (const kind of ["static", "unit", "integration", "e2e"] as const) {
      result[kind] = (configured[kind] ?? []).map((item) => ({
        kind,
        command: item.command,
        cwd: item.cwd ?? workspace,
        environment: item.environment ?? {},
        buildTimeEnvironment: item.buildTimeEnvironment ?? [],
        requiresServices: item.requiresServices ?? [],
        optional: item.optional ?? false,
      }));
    }
    return result;
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== "string") continue;
    const kind = checkKindForScript(name);
    result[kind].push({ kind, command: value, cwd: workspace, environment: {}, buildTimeEnvironment: [], requiresServices: [], optional: false });
  }
  return result;
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
  repositoryOverrides?: ToolchainRepositoryOverrides;
}): ResolvedToolchain {
  const { tip, configuration, repositoryOverrides } = input;
  if (tip.source === "host-checkout") {
    throw new Error("Toolchain resolution requires the PR tip tree; host checkout is not valid");
  }
  const files = Object.fromEntries(Object.entries(tip.files).map(([path, content]) => [path.replace(/^\.\//, ""), content]));
  const detectors = DETECTORS.filter((detector) => detector.declarations.some((file) =>
    Object.keys(files).some((path) => path === file || path.endsWith(`/${file}`)),
  ));
  const resolvedConfiguration = {
    workspace: configuration?.workspace ?? ".",
    qualityCommands: configuration?.qualityCommands ? [...configuration.qualityCommands] : [],
    ...(configuration?.workspaces ? { workspaces: [...configuration.workspaces] } : {}),
    ...(configuration?.checks ? { checks: configuration.checks } : {}),
  };
  const tipInfo = { headSha: tip.headSha, source: tip.source } as const;

  if (detectors.length === 0) {
    const unsupported = UNSUPPORTED_DECLARATIONS.find((file) => file in files);
    return withFingerprint({
      status: "unsupported",
      tip: tipInfo,
      identity: null,
      configuration: resolvedConfiguration,
      execution: { image: null, installCommand: null, qualityCommands: [], checks: EMPTY_CHECKS, workspaces: [] },
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
  const hasDependencyLock = ecosystem === "python"
    ? lockfiles.includes("uv.lock") || lockfiles.includes("poetry.lock") || lockfiles.includes("requirements.txt")
    : lockfiles.length > 0;
  const installCommand = !hasDependencyLock ? null
    : ecosystem === "node"
      ? manager?.name === "pnpm" ? `corepack ${manager.name}${manager.version ? `@${manager.version}` : ""} install --frozen-lockfile`
        : manager?.name === "yarn" ? `corepack yarn${manager.version ? `@${manager.version}` : ""} install --immutable`
          : `corepack npm${manager?.version ? `@${manager.version}` : ""} ci`
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
  if (!hasDependencyLock) conflicts.push(`No ${ecosystem[0].toUpperCase()}${ecosystem.slice(1)} dependency lockfile detected`);
  const checks = qualityCommands(ecosystem, files, configuration);
  const image = runtimeImage(ecosystem, runtime);
  if (ecosystem === "php" && runtime.php && /^(?:<\s*8\.3|~\s*8\.[0-2]|\^\s*8\.[0-2])/.test(runtime.php)) {
    conflicts.push(`PHP constraint ${runtime.php} is incompatible with the pinned composer:2.8 runtime`);
  }
  if (repositoryOverrides?.runnerImage && repositoryOverrides.runnerImage !== image) {
    conflicts.push(`Repository runnerImage conflicts with the resolved ${ecosystem} toolchain`);
  }
  if (repositoryOverrides?.installCommand && repositoryOverrides.installCommand !== installCommand) {
    conflicts.push(`Repository installCommand conflicts with the resolved ${manager?.name ?? ecosystem} toolchain`);
  }
  const workspacePaths = ecosystem === "node" ? packageWorkspaces(files, configuration) : [configuration?.workspace ?? "."];
  const workspaceDeclarations = ecosystem === "node" ? packageDirectories(files) : Object.keys(files)
    .filter((file) => DETECTORS.some((detector) => detector.declarations.includes(file.split("/").pop() ?? "")))
    .map((file) => file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");
  for (const workspace of workspacePaths) {
    if (workspace !== "." && !(`${workspace}/package.json` in files || Object.keys(files).some((file) => file.startsWith(`${workspace}/`)))) {
      conflicts.push(`Configured workspace does not exist in the PR tip tree: ${workspace}`);
    }
  }
  if (workspaceDeclarations.length > 1 && workspacePaths.length === 1 && workspacePaths[0] === "." && ecosystem !== "node") {
    conflicts.push(`Multiple ${ecosystem} package roots detected (${workspaceDeclarations.join(", ")}); configure workspaces to select one`);
  }
  const workspaceResults = workspacePaths.map((path) => ({
    path,
    installRoot: ecosystem === "node" ? "." : path,
    commands: checksForWorkspace(files, path, configuration),
  }));
  const categorized = workspaceResults.reduce<Record<CheckKind, ResolvedQualityCommand[]>>((all, workspace) => {
    for (const kind of ["static", "unit", "integration", "e2e"] as const) all[kind].push(...workspace.commands[kind]);
    return all;
  }, { static: [], unit: [], integration: [], e2e: [] });
  return withFingerprint({
    status: conflicts.length > 0 ? "ambiguous" : "resolved",
    tip: tipInfo,
    identity,
    configuration: resolvedConfiguration,
    execution: { image, installCommand, qualityCommands: checks, checks: categorized, workspaces: workspaceResults },
    conflicts,
  }, files);
}

export async function resolveToolchainFromReader(input: TipTreeReader & {
  configuration?: ToolchainConfiguration;
  repositoryOverrides?: ToolchainRepositoryOverrides;
}): Promise<ResolvedToolchain> {
  const entries = await Promise.all(TOOLCHAIN_MANIFEST_FILES.map(async (path) => ({ path, content: await input.readFile(path) })));
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry.content === "string") files[entry.path] = entry.content;
  }
  return resolveToolchain({
    tip: { headSha: input.headSha, source: input.source, files },
    configuration: input.configuration,
    repositoryOverrides: input.repositoryOverrides,
  });
}
