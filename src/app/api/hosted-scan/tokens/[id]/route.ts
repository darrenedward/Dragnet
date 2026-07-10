import { NextResponse } from "next/server";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { revokeScanToken } from "@/src/services/hostedScan/scanToken";

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrKey(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { id } = await props.params;
  await revokeScanToken(id);
  return NextResponse.json({ ok: true });
}
