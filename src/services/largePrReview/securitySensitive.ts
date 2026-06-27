const GLOBAL_DEFAULTS = [
  "src/app/api/auth/**",
  "src/app/api/webhooks/**",
  "src/app/api/hooks/**",
  "src/lib/apiAuth.ts",
  "src/lib/pathSafety.ts",
  "src/lib/crypto.ts",
  "src/lib/webhook.ts",
  "src/services/findingVerifier.ts",
  "prisma/schema.prisma",
  ".env*",
];

const KEYWORD_FALLBACK = [
  "**/*auth*",
  "**/*session*",
  "**/*crypto*",
  "**/*secret*",
  "**/*token*",
  "**/*key*",
  "**/*webhook*",
  "**/*permission*",
  "**/*rbac*",
];

export function isSecuritySensitive(
  filename: string,
  repoConfiguredPaths: string[] = [],
): boolean {
  const normalized = normalizePath(filename);
  return [...GLOBAL_DEFAULTS, ...KEYWORD_FALLBACK, ...repoConfiguredPaths]
    .filter(Boolean)
    .some((pattern) => matchGlob(normalized, pattern));
}

export function matchGlob(filename: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(filename);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
