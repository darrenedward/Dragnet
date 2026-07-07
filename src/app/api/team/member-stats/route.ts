import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export const runtime = "nodejs";

/**
 * GET /api/team/member-stats
 *
 * Returns the count of non-revoked API keys grouped by userId. Used by the
 * Team panel to show "X keys" next to each member. Single-tenant: any
 * authenticated user can see all keys (they're already visible via
 * /api/keys). Org-scoped read would require gating by Better Auth's active
 * organization membership — left as a follow-up.
 */
export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const rows = await prisma.apiKey.groupBy({
    by: ["userId"],
    where: { revoked: false, userId: { not: null } },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.userId) counts[row.userId] = row._count._all;
  }
  return NextResponse.json({ counts });
}