"use client";

/**
 * Global toast store — tiny pub/sub so any module (hooks, route handlers
 * on the client, error boundaries) can surface a single non-blocking
 * message. Browser `alert()` is modal and stacks badly under concurrent
 * failures (e.g. 4 background pollers + a click handler all hitting a
 * dead server = 5 stacked dialogs). This dedups identical messages within
 * a sliding window so the user sees ONE toast, not five.
 *
 * Severity-tagged so the Toaster component can color-code. Network errors
 * get a longer dedup window (30s) since outages tend to persist across
 * several poll cycles; user-action errors (5s) refresh sooner so genuine
 * repeats still surface.
 */

import { useEffect, useState } from "react";

export type ToastSeverity = "info" | "success" | "warn" | "error";

export interface Toast {
  id: string;
  severity: ToastSeverity;
  message: string;
  createdAt: number;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const recentMessages = new Map<string, number>();

const DEFAULT_DEDUP_MS = 5000;
const NETWORK_DEDUP_MS = 30000;
const AUTO_DISMISS_MS = 8000;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `toast-${Date.now()}-${counter}`;
}

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

function push(severity: ToastSeverity, message: string, dedupMs: number): void {
  if (typeof window === "undefined") return;
  const key = `${severity}:${message}`;
  const now = Date.now();
  const lastSeen = recentMessages.get(key);
  if (lastSeen !== undefined && now - lastSeen < dedupMs) {
    // Slide the window so a sustained outage emits at most one toast per
    // dedupMs, not one per caller.
    recentMessages.set(key, now);
    return;
  }
  recentMessages.set(key, now);
  const toast: Toast = { id: nextId(), severity, message, createdAt: now };
  toasts = [...toasts, toast];
  emit();
  // Auto-dismiss after AUTO_DISMISS_MS. Stale toasts shouldn't linger once
  // the underlying issue resolves.
  setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
}

export function dismiss(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function clearAll(): void {
  toasts = [];
  emit();
}

export const toast = {
  info: (msg: string) => push("info", msg, DEFAULT_DEDUP_MS),
  success: (msg: string) => push("success", msg, DEFAULT_DEDUP_MS),
  warn: (msg: string) => push("warn", msg, DEFAULT_DEDUP_MS),
  error: (msg: string) => push("error", msg, DEFAULT_DEDUP_MS),
  /** Network-error shorthand: friendly copy + extended dedup. */
  networkError: () =>
    push(
      "error",
      "Lost connection to the Dragnet server. Please check it's running and try again.",
      NETWORK_DEDUP_MS,
    ),
  /** Server 5xx shorthand: distinct copy for "server's up but broken". */
  serverError: (detail?: string) =>
    push(
      "error",
      detail
        ? `Server error: ${detail}. If this persists, contact your administrator.`
        : "The Dragnet server reported an error. If this persists, contact your administrator.",
      NETWORK_DEDUP_MS,
    ),
};

/**
 * React hook for components that want to render the current toast stack.
 * Subscribes on mount, unsubscribes on unmount. Returns a snapshot array
 * that updates whenever the store changes.
 */
export function useToasts(): Toast[] {
  const [snapshot, setSnapshot] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setSnapshot);
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}
