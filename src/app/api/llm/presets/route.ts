import { NextResponse } from "next/server";
import {
  listPresets,
  savePresets,
  validatePresetsInput,
  type Preset,
  type PresetsFile,
} from "@/src/lib/llmPresets";
import { requireSession } from "@/src/lib/api-auth";

export async function GET(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(listPresets());
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || String(err) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const incoming = await req.json().catch(() => ({}));
    validatePresetsInput(incoming);

    const mergedPresets: Preset[] = incoming.presets.map((p: Preset) => {
      return {
        id: p.id,
        name: p.name,
        endpoint: p.endpoint,
        // Three-state contract: undefined = "keep stored", "" = "clear",
        // "value" = "rotate". Preserve undefined as-is instead of forcing
        // it to "" — that's what was wiping the stored key on every Save
        // when the user only wanted to change a model field.
        apiKey: p.apiKey === undefined ? undefined : p.apiKey,
        chatModel: p.chatModel,
        embeddingModel: p.embeddingModel,
        ...(typeof p.maxIterations === "number"
          ? { maxIterations: Math.floor(p.maxIterations) }
          : {}),
      };
    });

    const state: PresetsFile = {
      presets: mergedPresets,
      primaryChatPresetId: incoming.primaryChatPresetId,
      fallbackChatPresetId: incoming.fallbackChatPresetId ?? "",
      primaryEmbeddingPresetId: incoming.primaryEmbeddingPresetId,
      fallbackEmbeddingPresetId: incoming.fallbackEmbeddingPresetId ?? "",
    };

    await savePresets(state);

    return NextResponse.json({
      ok: true,
      restartRequired: false,
      message: "Presets saved.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
