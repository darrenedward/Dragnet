import { prisma } from "./prisma";
import crypto from "crypto";

const KEY_PREFIX = "gl_mcp_";

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = KEY_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 12) + "...";
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, prefix, hash };
}

function hashKey(raw: string): string | null {
  if (!raw.startsWith(KEY_PREFIX)) return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function authenticateMcpRequest(req: Request): Promise<{ ok: boolean; error?: string }> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return { ok: false, error: "Missing or invalid Authorization header. Use: Authorization: Bearer gl_mcp_<key>" };
  }

  const raw = auth.slice("Bearer ".length).trim();
  const hash = hashKey(raw);
  if (!hash) {
    return { ok: false, error: "Invalid API key format. Keys start with 'gl_mcp_'." };
  }

  const key = await prisma.mcpApiKey.findUnique({ where: { hash } });
  if (!key || key.revoked) {
    return { ok: false, error: "API key not found or has been revoked." };
  }

  await prisma.mcpApiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return { ok: true };
}
