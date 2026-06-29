import { NextResponse } from "next/server";
import {
  listPresets,
  readPresets,
  savePresets,
  validatePresetsInput,
  type Preset,
  type PresetsFile,
} from "@/src/lib/llmPresets";
import { requireSession } from "@/src/lib/api-auth";

/**
 * GET /api/llm/presets
 * Returns the full preset list with apiKeys masked. Safe for client use.
 */
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

/**
 * PUT /api/llm/presets
 * Body: the full { presets, primaryChatPresetId, fallbackChatPresetId,
 * primaryEmbeddingPresetId, fallbackEmbeddingPresetId } state.
 * Client is source of truth — server validates and persists atomically.
 *
 * If a preset's apiKey field is empty AND we already have a stored key for
 * that preset id, the stored key is preserved (so the user doesn't have to
 * re-enter it on every save). To remove a key, delete the preset entirely.
 */
export async function PUT(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const incoming = await req.json().catch(() => ({}));
    validatePresetsInput(incoming);

    const previousByKey = new Map(readPresets().presets.map((p) => [p.id, p]));

    const mergedPresets: Preset[] = incoming.presets.map((p: Preset) => {
      let apiKey = p.apiKey || "";
      if (!apiKey) {
        const prev = previousByKey.get(p.id);
        if (prev) apiKey = prev.apiKey;
      }
      return {
        id: p.id,
        name: p.name,
        endpoint: p.endpoint,
        apiKey,
        chatModel: p.chatModel,
        embeddingModel: p.embeddingModel,
        // Optional — keep legacy presets unchanged when the field is absent.
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
