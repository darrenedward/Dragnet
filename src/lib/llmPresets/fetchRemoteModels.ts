import type { RemoteModelsResult } from "./types";

export async function fetchRemoteModels(
  endpoint: string,
  apiKey: string,
): Promise<RemoteModelsResult> {
  if (!endpoint) return { ok: false, error: "Endpoint URL is required." };

  const isLocal = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(endpoint);
  if (!apiKey && !isLocal) {
    return { ok: false, error: "API key is required for this endpoint." };
  }

  try {
    const url = `${endpoint.replace(/\/$/, "")}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey || "no-key-required"}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Endpoint returned ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    const raw: any[] = data.data || data.models || [];
    const models = raw
      .map((m: any) => ({
        id: typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "",
        name: typeof m.name === "string" ? m.name : undefined,
      }))
      .filter((m) => m.id.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));

    return { ok: true, count: models.length, models };
  } catch (e: any) {
    const msg =
      e?.name === "AbortError"
        ? "Timed out after 8s waiting for endpoint response."
        : e?.message || String(e);
    return { ok: false, error: msg };
  }
}
