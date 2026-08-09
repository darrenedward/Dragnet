export interface ServiceHealthcheck {
  readonly command: readonly string[];
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
}

export interface DisposableServiceDeclaration {
  readonly name: string;
  /** Must be version-pinned (tag other than latest or an immutable digest). */
  readonly image: string;
  readonly alias: string;
  readonly healthcheck: ServiceHealthcheck;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly sqlite?: boolean;
}

export interface DisposableServicePlan {
  readonly scanId: string;
  readonly networkName: string;
  readonly services: readonly (DisposableServiceDeclaration & {
    readonly containerName: string;
    readonly volumeName: string;
    readonly sqlitePath?: string;
  })[];
}

export interface ServiceLifecycleResult {
  readonly started: readonly string[];
  readonly cleaned: readonly string[];
  readonly errors: readonly string[];
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
}

function assertPinned(image: string): void {
  const [name, tag] = image.split("@")[0].split(":");
  if (image.includes("@sha256:")) return;
  if (!tag || tag === "latest" || !name) throw new Error(`Service image must be version-pinned: ${image}`);
}

export function createDisposableServicePlan(scanId: string, declarations: readonly DisposableServiceDeclaration[]): DisposableServicePlan {
  if (!scanId || declarations.length === 0) return { scanId, networkName: `dragnet-scan-${safePart(scanId)}`, services: [] };
  const names = new Set<string>();
  const aliases = new Set<string>();
  const services = declarations.map((service) => {
    assertPinned(service.image);
    if (names.has(service.name) || aliases.has(service.alias)) throw new Error(`Duplicate disposable service name or alias: ${service.name}`);
    if (service.healthcheck.command.length === 0) throw new Error(`Service ${service.name} requires a health check`);
    names.add(service.name);
    aliases.add(service.alias);
    return {
      ...service,
      containerName: `dragnet-scan-${safePart(scanId)}-${safePart(service.name)}`,
      volumeName: `dragnet-scan-${safePart(scanId)}-${safePart(service.name)}`,
      ...(service.sqlite ? { sqlitePath: `/tmp/dragnet-scan-${safePart(scanId)}/${safePart(service.name)}.sqlite` } : {}),
    };
  });
  return { scanId, networkName: `dragnet-scan-${safePart(scanId)}`, services };
}

export interface ServiceLifecycleAdapter {
  start(service: DisposableServicePlan["services"][number], networkName: string): Promise<void>;
  stop(service: DisposableServicePlan["services"][number]): Promise<void>;
  removeNetwork(networkName: string): Promise<void>;
}

/** Endpoint and credential variables are generated only for commands that declare the service. */
export function serviceEnvironment(
  command: { readonly requiresServices: readonly string[] },
  plan: DisposableServicePlan,
): Readonly<Record<string, string>> {
  const selected = plan.services.filter((service) => command.requiresServices.includes(service.name));
  return Object.fromEntries(selected.flatMap((service) => [
    [`${safePart(service.name).toUpperCase()}_HOST`, service.alias],
    ...Object.entries(service.credentials ?? {}),
  ]));
}

/** Docker/Podman adapter. It deliberately accepts no host path or bind mount. */
export function createContainerServiceAdapter(engine: "docker" | "podman" = "docker"): ServiceLifecycleAdapter {
  const run = async (args: string[]) => execFile(engine, args, { encoding: "utf8", timeout: 30_000 });
  return {
    async start(service, networkName) {
      // The network is idempotent across services in one scan.
      try { await run(["network", "create", "--internal", networkName]); } catch { /* already created */ }
      await run(["volume", "create", service.volumeName]);
      const args = [
        "run", "-d", "--rm", "--name", service.containerName,
        "--network", networkName, "--network-alias", service.alias,
        "-v", `${service.volumeName}:/var/lib/dragnet-service`,
        "--health-cmd", service.healthcheck.command.join(" "),
        "--health-interval", `${service.healthcheck.intervalMs ?? 1000}ms`,
        "--health-timeout", `${service.healthcheck.timeoutMs ?? 500}ms`,
        "--health-retries", `${service.healthcheck.retries ?? 30}`,
      ];
      for (const [key, value] of Object.entries(service.credentials ?? {})) args.push("-e", `${key}=${value}`);
      args.push(service.image);
      try {
        await run(args);
        const deadline = Date.now() + (service.startupTimeoutMs ?? 30_000);
        while (Date.now() < deadline) {
          const state = await run(["inspect", "--format", "{{.State.Health.Status}}", service.containerName]);
          if (state.stdout.trim() === "healthy") return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`health check timed out after ${service.startupTimeoutMs ?? 30_000}ms`);
      } catch (error) {
        try { await run(["rm", "-f", service.containerName]); } catch { /* preserve startup failure */ }
        try { await run(["volume", "rm", "-f", service.volumeName]); } catch { /* preserve startup failure */ }
        throw error;
      }
    },
    async stop(service) {
      try { await run(["rm", "-f", service.containerName]); }
      finally { await run(["volume", "rm", "-f", service.volumeName]); }
    },
    async removeNetwork(networkName) {
      await run(["network", "rm", networkName]);
    },
  };
}

/** Starts services in order and always attempts every cleanup operation. */
export async function withDisposableServices<T>(
  plan: DisposableServicePlan,
  adapter: ServiceLifecycleAdapter,
  run: () => Promise<T>,
): Promise<{ value?: T; lifecycle: ServiceLifecycleResult }> {
  const started: string[] = [];
  const cleaned: string[] = [];
  const errors: string[] = [];
  try {
    for (const service of plan.services) {
      try {
        await adapter.start(service, plan.networkName);
        started.push(service.name);
      } catch (error) {
        errors.push(`Failed to start ${service.name}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    const value = errors.length === 0 ? await run() : undefined;
    return { value, lifecycle: { started, cleaned, errors } };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { lifecycle: { started, cleaned, errors } };
  } finally {
    for (const service of [...plan.services].reverse()) {
      if (!started.includes(service.name)) continue;
      try { await adapter.stop(service); cleaned.push(service.name); }
      catch (error) { errors.push(`Failed to clean up ${service.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { await adapter.removeNetwork(plan.networkName); }
    catch (error) { errors.push(`Failed to clean up network: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
