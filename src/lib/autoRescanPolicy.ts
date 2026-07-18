import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/src/lib/prisma";

export type AutoRescanOverride = "inherit" | "enabled" | "disabled";

export interface AutoRescanSettings {
  defaultEnabled: boolean;
}

const DEFAULT_SETTINGS: AutoRescanSettings = { defaultEnabled: false };
const globalCache = globalThis as typeof globalThis & {
  __autoRescanSettings?: AutoRescanSettings;
};

function settingsPath(): string {
  return join(process.cwd(), ".dragnet", "auto-rescan.json");
}

function settingsTmpPath(): string {
  return `${settingsPath()}.tmp`;
}

export function readAutoRescanSettings(): AutoRescanSettings {
  if (globalCache.__autoRescanSettings) return globalCache.__autoRescanSettings;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<AutoRescanSettings>;
    globalCache.__autoRescanSettings = { defaultEnabled: parsed.defaultEnabled === true };
  } catch {
    globalCache.__autoRescanSettings = { ...DEFAULT_SETTINGS };
  }
  return globalCache.__autoRescanSettings;
}

export async function saveAutoRescanSettings(settings: AutoRescanSettings): Promise<void> {
  const next = { defaultEnabled: settings.defaultEnabled === true };
  await mkdir(join(process.cwd(), ".dragnet"), { recursive: true });
  await writeFile(settingsTmpPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(settingsTmpPath(), settingsPath());
  await chmod(settingsPath(), 0o600);
  globalCache.__autoRescanSettings = next;
}

export function clearAutoRescanSettingsCache(): void {
  delete globalCache.__autoRescanSettings;
}

export function isAutoRescanEnabled(
  override: AutoRescanOverride | string | null | undefined,
  settings = readAutoRescanSettings(),
): boolean {
  if (override === "enabled") return true;
  if (override === "disabled") return false;
  return settings.defaultEnabled;
}

export async function isAutoRescanEnabledForRepo(repoId: string): Promise<boolean> {
  const repo = await prisma.repository.findUnique({
    where: { id: repoId },
    select: { autoRescanPolicy: true },
  });
  return repo ? isAutoRescanEnabled(repo.autoRescanPolicy) : false;
}
