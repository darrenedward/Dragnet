import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateApiRequest } from "@/src/lib/apiAuth";

export async function GET(req: NextRequest) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const dir = req.nextUrl.searchParams.get("dir") || "";
  const name = req.nextUrl.searchParams.get("name") || "";
  if (!dir && !name) return NextResponse.json({ repo: null });

  const repos = await prisma.repository.findMany();

  if (dir) {
    const lowerDir = dir.toLowerCase();
    const pathMatch = repos.find((r) => dir.startsWith(r.path) || lowerDir.startsWith(r.path.toLowerCase()));
    if (pathMatch) return NextResponse.json({ repo: { id: pathMatch.id, name: pathMatch.name } });

    const basename = dir.split("/").filter(Boolean).pop() || "";
    const lowerBase = basename.toLowerCase();
    const nameMatch = repos.find((r) => r.name.toLowerCase() === lowerBase);
    if (nameMatch) return NextResponse.json({ repo: { id: nameMatch.id, name: nameMatch.name } });
  }

  if (name) {
    const lowerName = name.toLowerCase();
    const nameMatch = repos.find((r) => r.name.toLowerCase() === lowerName || r.id.toLowerCase().includes(lowerName));
    if (nameMatch) return NextResponse.json({ repo: { id: nameMatch.id, name: nameMatch.name } });
  }

  return NextResponse.json({ repo: null });
}
