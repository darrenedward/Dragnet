"use client";

import { useEffect, useState } from "react";

export default function AutoRescanPanel() {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/llm/auto-rescan")
      .then((res) => res.json())
      .then((data) => setEnabled(data.settings?.defaultEnabled === true))
      .catch(() => setMessage("Unable to load automatic rescan settings."));
  }, []);

  const save = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/llm/auto-rescan", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultEnabled: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed.");
      setMessage("Saved. New commits will follow this default unless a repository overrides it.");
    } catch (err: any) {
      setEnabled(!next);
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border border-white/10 rounded-xl p-4 space-y-3">
      <div>
        <h3 className="text-sm font-bold text-white">Automatic rescans</h3>
        <p className="text-[11px] text-slate-500 mt-1">Global default for newly detected PR commits. Repository overrides are configured in repository settings.</p>
      </div>
      <label className="flex items-center justify-between gap-4 text-xs text-slate-300">
        <span>Enqueue new revisions automatically</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(event) => void save(event.target.checked)}
          className="accent-emerald-500"
        />
      </label>
      {message && <p className="text-[11px] text-slate-400">{message}</p>}
    </section>
  );
}
