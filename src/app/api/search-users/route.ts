import { NextResponse } from "next/server";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { searchUsersByName } from "@/src/lib/userSearch";

const MAX_Q_LEN = 100;

export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").slice(0, MAX_Q_LEN);

  if (!query) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  const users = await searchUsersByName(query);

  return NextResponse.json({ users });
}
