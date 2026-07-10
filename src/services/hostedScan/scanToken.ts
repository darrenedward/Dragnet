import crypto from "node:crypto";
import { prisma } from "@/src/lib/prisma";

const TOKEN_PREFIX = "hs_";

export type ScanTokenResult =
  | { ok: true; token: { id: string; raw: string; prefix: string } }
  | { ok: false; error: string };

export type AuthScanTokenResult =
  | { ok: true; repoId: string; tokenId: string }
  | { ok: false; error: string };

export function generateScanTokenRaw(): { raw: string; prefix: string; hash: string } {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 8) + "...";
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, prefix, hash };
}

export function hashScanToken(raw: string): string | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function createScanToken(repoId: string, label: string): Promise<ScanTokenResult> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) return { ok: false, error: "Repository not found" };
  if (!repo.hostedMode) return { ok: false, error: "Repository is not in hosted mode" };

  const { raw, prefix, hash } = generateScanTokenRaw();
  const record = await prisma.scanToken.create({
    data: { repoId, label, prefix, hash },
  });

  return { ok: true, token: { id: record.id, raw, prefix } };
}

export async function authenticateScanToken(raw: string): Promise<AuthScanTokenResult> {
  const hash = hashScanToken(raw);
  if (!hash) return { ok: false, error: "Invalid scan token format" };

  const record = await prisma.scanToken.findUnique({ where: { hash } });
  if (!record || record.revoked) {
    return { ok: false, error: "Scan token not found or has been revoked" };
  }

  const lastMs = record.lastUsedAt ? new Date(record.lastUsedAt).getTime() : 0;
  if (Date.now() - lastMs > 5 * 60_000) {
    prisma.scanToken
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  return { ok: true, repoId: record.repoId, tokenId: record.id };
}

export async function revokeScanToken(id: string): Promise<{ ok: boolean }> {
  await prisma.scanToken.update({ where: { id }, data: { revoked: true } });
  return { ok: true };
}

export async function listScanTokens(repoId: string) {
  return prisma.scanToken.findMany({
    where: { repoId },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, prefix: true, createdAt: true, revoked: true },
  });
}
