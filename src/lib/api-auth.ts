import { auth } from "./auth";

export async function getSession(request?: Request) {
  if (request) {
    return auth.api.getSession({ headers: request.headers });
  }
  const { headers } = await import("next/headers");
  const h = await headers();
  return auth.api.getSession({ headers: h });
}

export async function requireSession(request?: Request) {
  const session = await getSession(request);
  if (!session) {
    throw new Error("Unauthorized");
  }
  return session;
}
