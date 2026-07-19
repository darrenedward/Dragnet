export type ConfigHealthSeverity = "blocking" | "warning";
export type ConfigHealthStatus = "ok" | "missing" | "invalid";

export interface ConfigHealthItem {
  id: string;
  label: string;
  variables: string[];
  status: ConfigHealthStatus;
  severity: ConfigHealthSeverity;
  feature: string;
  message: string;
  action: string;
  restartRequired: boolean;
}

export interface ConfigHealthReport {
  ok: boolean;
  status: "ok" | "needs_setup";
  summary: string;
  items: ConfigHealthItem[];
  generatedAt: string;
}

type EnvMap = Record<string, string | undefined>;

const PLACEHOLDER_RE = /\b(YOUR|USER|PASSWORD|HOST|example|placeholder)\b|\.{3}/i;

export function getConfigHealth(env: EnvMap = process.env): ConfigHealthReport {
  const items: ConfigHealthItem[] = [
    databaseUrlHealth(env),
    masterKeyHealth(env),
    githubAppHealth(env),
    publicUrlHealth(env),
  ].filter((item): item is ConfigHealthItem => item !== null);

  const actionable = items.filter((item) => item.status !== "ok");
  const blockingCount = actionable.filter((item) => item.severity === "blocking").length;

  return {
    ok: actionable.length === 0,
    status: actionable.length === 0 ? "ok" : "needs_setup",
    summary:
      actionable.length === 0
        ? "Environment configuration is complete."
        : `${blockingCount || actionable.length} environment ${blockingCount === 1 ? "item" : "items"} need attention.`,
    items: actionable,
    generatedAt: new Date().toISOString(),
  };
}

function databaseUrlHealth(env: EnvMap): ConfigHealthItem | null {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) {
    return missingItem({
      id: "database-url",
      label: "Database connection",
      variables: ["DATABASE_URL"],
      feature: "App data, auth, repositories, reviews",
      message: "DATABASE_URL is not set. Dragnet will fall back to local Postgres, which is usually not what you want.",
      action: "Add DATABASE_URL to .env.local, then restart Dragnet.",
      severity: "blocking",
    });
  }
  if (PLACEHOLDER_RE.test(raw)) {
    return invalidItem({
      id: "database-url",
      label: "Database connection",
      variables: ["DATABASE_URL"],
      feature: "App data, auth, repositories, reviews",
      message: "DATABASE_URL still looks like a placeholder.",
      action: "Replace DATABASE_URL with the real Postgres connection string, then restart Dragnet.",
      severity: "blocking",
    });
  }
  return null;
}

function masterKeyHealth(env: EnvMap): ConfigHealthItem | null {
  const raw = env.DRAGNET_MASTER_KEY?.trim();
  if (!raw) {
    return missingItem({
      id: "master-key",
      label: "Secret encryption key",
      variables: ["DRAGNET_MASTER_KEY"],
      feature: "Remote repo credentials, PATs, deploy keys, GitHub OAuth tokens",
      message: "DRAGNET_MASTER_KEY is not set. Dragnet cannot encrypt saved remote credentials.",
      action: "Generate a 32-byte base64 key, add DRAGNET_MASTER_KEY to .env.local, then restart Dragnet.",
      severity: "blocking",
    });
  }
  if (Buffer.from(raw, "base64").length !== 32) {
    return invalidItem({
      id: "master-key",
      label: "Secret encryption key",
      variables: ["DRAGNET_MASTER_KEY"],
      feature: "Remote repo credentials, PATs, deploy keys, GitHub OAuth tokens",
      message: "DRAGNET_MASTER_KEY must decode to exactly 32 bytes.",
      action: "Replace DRAGNET_MASTER_KEY with a 32-byte base64 key, then restart Dragnet.",
      severity: "blocking",
    });
  }
  return null;
}

function githubAppHealth(env: EnvMap): ConfigHealthItem | null {
  const vars = [
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
  ];
  const configured = vars.filter((name) => Boolean(env[name]?.trim()));
  if (configured.length === 0 || configured.length === vars.length) return null;

  return missingItem({
    id: "github-app",
    label: "GitHub App integration",
    variables: vars.filter((name) => !env[name]?.trim()),
    feature: "GitHub OAuth and GitHub App HTTPS cloning",
    message: "GitHub App configuration is partial. OAuth and app-token cloning can fail until the missing values are set.",
    action: "Complete the missing GitHub App variables in .env.local, then restart Dragnet.",
    severity: "warning",
  });
}

function publicUrlHealth(env: EnvMap): ConfigHealthItem | null {
  const usesExternalCallbacks =
    Boolean(env.GITHUB_APP_ID?.trim()) ||
    Boolean(env.GITHUB_APP_CLIENT_ID?.trim()) ||
    Boolean(env.DRAGNET_POLLING_ENABLED === "1");
  const serverUrl = env.DRAGNET_URL?.trim();
  const hasNonLocalServerUrl = Boolean(serverUrl && !/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/i.test(serverUrl));
  if (!usesExternalCallbacks || env.DRAGNET_PUBLIC_URL?.trim() || hasNonLocalServerUrl) return null;

  return missingItem({
    id: "public-url",
    label: "Public callback URL",
    variables: ["DRAGNET_PUBLIC_URL"],
    feature: "Webhook delivery and callback URLs",
    message: "External callback features are configured, but DRAGNET_PUBLIC_URL is not set. Dragnet will advertise localhost URLs.",
    action: "Use the banner button to save the current server address, or set DRAGNET_PUBLIC_URL for a deployment override.",
    severity: "warning",
  });
}

function missingItem(input: Omit<ConfigHealthItem, "status" | "restartRequired">): ConfigHealthItem {
  return { ...input, status: "missing", restartRequired: true };
}

function invalidItem(input: Omit<ConfigHealthItem, "status" | "restartRequired">): ConfigHealthItem {
  return { ...input, status: "invalid", restartRequired: true };
}
