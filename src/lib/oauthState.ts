const csrfTokens = new Map<string, { token: string; createdAt: number }>();
const CSRF_TTL_MS = 10 * 60 * 1000;

export function storeCsrfToken(userId: string, token: string): void {
  csrfTokens.set(userId, { token, createdAt: Date.now() });
}

export function consumeCsrfToken(userId: string, token: string): boolean {
  const stored = csrfTokens.get(userId);
  if (!stored) return false;
  const match = stored.token === token && Date.now() - stored.createdAt < CSRF_TTL_MS;
  if (match) csrfTokens.delete(userId);
  return match;
}
