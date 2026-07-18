import { NextResponse } from "next/server";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { getConfigHealth } from "@/src/lib/configHealth";
import { publicUrlIsConfigured } from "@/src/lib/publicUrl";

export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const env = { ...process.env };
  if (publicUrlIsConfigured()) env.DRAGNET_PUBLIC_URL = "configured-in-dragnet-settings";
  return NextResponse.json(getConfigHealth(env));
}
