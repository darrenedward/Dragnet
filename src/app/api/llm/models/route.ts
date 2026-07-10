import { NextResponse } from "next/server";
import { fetchRemoteModels, getPreset, getPresetByEndpoint } from "@/src/lib/llmPresets";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function POST(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const presetId = typeof body.presetId === "string" ? body.presetId.trim() : "";

    let effectiveKey = apiKey;
    if (!effectiveKey && presetId) {
      const preset = await getPreset(presetId);
      if (preset) effectiveKey = preset.apiKey;
    }
    if (!effectiveKey && endpoint) {
      const preset = await getPresetByEndpoint(endpoint);
      if (preset) effectiveKey = preset.apiKey;
    }

    const result = await fetchRemoteModels(endpoint, effectiveKey);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      );
    }
    return NextResponse.json({
      success: true,
      count: result.count,
      models: result.models,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
