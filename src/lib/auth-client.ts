import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { redirectToLogin } from "./http";

/**
 * Better Auth client. Single instance used across the dashboard for
 * signIn / signOut / useSession.
 *
 * `fetchOptions.onError` is Better Auth's documented hook for responding
 * to auth-fetch failures globally (see Better Auth Next.js integration
 * guide). On a 401 — session cookie expired, revoked, or never issued —
 * we bounce to /login with the current path preserved as `callbackURL`.
 *
 * Note: this catches ONLY calls made through `authClient.*` (signIn,
 * useSession, etc.). App API fetches (/api/repos, /api/prs/...) need to
 * go through `fetchJson` from `./http` for the same treatment.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL!,
  plugins: [organizationClient()],
  fetchOptions: {
    onError: (ctx) => {
      if (ctx.response.status === 401) {
        redirectToLogin();
      }
    },
  },
});
