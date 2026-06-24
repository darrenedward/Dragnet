import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateIfExternal } from "@/src/lib/apiAuth";
import { setupWebhookWithPat, deleteWebhook, getManualWebhookInstructions } from "@/src/lib/webhookSetup";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateIfExternal(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const { id } = await params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));

    if (body.webhookId) {
      await prisma.repository.update({
        where: { id },
        data: { webhookId: String(body.webhookId) },
      });
      return NextResponse.json({ success: true, webhookId: String(body.webhookId) });
    }

    if (!repo.patCipher) {
      return NextResponse.json(
        { error: "No PAT stored. Set up the webhook manually and provide the webhookId." },
        { status: 400 },
      );
    }

    const result = await setupWebhookWithPat(id, { targetUrl: body.targetUrl });
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error("Error setting up webhook:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateIfExternal(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const { id } = await params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }
    const instructions = getManualWebhookInstructions({
      ...repo,
      webhookSecret: repo.webhookSecret ? "(set — redacted)" : null,
    });
    return NextResponse.json({ instructions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateIfExternal(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const { id } = await params;
    await deleteWebhook(id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error deleting webhook:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
