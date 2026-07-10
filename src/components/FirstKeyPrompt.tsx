"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { KeyRound } from "lucide-react";

/**
 * Post-invite nudge: when a user lands on the dashboard right after
 * accepting an invitation, /invite/[code] sets
 * `dragnet:just-accepted-invite=1` in localStorage. We read it on mount
 * and render a banner prompting them to generate their first API key —
 * they need one to use the CLI / pre-push hook (#48 ties keys to user
 * identity). Dismissing clears the flag.
 */
export default function FirstKeyPrompt({ onOpenKeys }: { onOpenKeys: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem("dragnet:just-accepted-invite") === "1") {
        setVisible(true);
      }
    } catch {
      /* storage blocked — silently skip */
    }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      window.localStorage.removeItem("dragnet:just-accepted-invite");
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-between gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-lg"
    >
      <div className="flex items-center gap-2 text-amber-300 font-mono text-xs">
        <KeyRound size={14} />
        <span>Welcome to the workspace. Generate your first API key to use the CLI or pre-push hook.</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onOpenKeys}
          className="bg-amber-500 hover:bg-amber-600 text-black font-semibold text-xs px-3 py-1.5 rounded-lg font-mono"
        >
          Generate key
        </button>
        <button
          onClick={dismiss}
          className="text-amber-300/80 hover:text-amber-200 text-xs font-mono px-2 py-1.5"
        >
          Skip
        </button>
      </div>
    </motion.div>
  );
}