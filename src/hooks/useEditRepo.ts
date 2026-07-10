"use client";
import { useState } from "react";
import type React from "react";
import type { Repository } from "../lib/types";

interface Options {
  onUpdated: () => Promise<void> | void;
  onWebhookPrompt: (repo: { id: string; name: string; hasPat: boolean }) => void;
}

/**
 * Edit-repo state + handlers, kept separate from useDashboardData to
 * stay under the 500-line file-size rule. App.tsx composes both hooks.
 *
 * Secret preservation: empty/blank deployKey or pat on submit means
 * "keep existing ciphertext" — server-side PUT handles the skip.
 */
export function useEditRepo({ onUpdated, onWebhookPrompt }: Options) {
  const [editingRepo, setEditingRepo] = useState<Repository | null>(null);
  const [showEditRepoModal, setShowEditRepoModal] = useState(false);
  const [errorFeedback, setErrorFeedback] = useState<string | null>(null);

  const [editMode, setEditMode] = useState<"ssh" | "pat">("ssh");
  const [editCloneUrl, setEditCloneUrl] = useState("");
  const [editCloneUrlHttps, setEditCloneUrlHttps] = useState("");
  const [editDeployKey, setEditDeployKey] = useState("");
  const [editPat, setEditPat] = useState("");
  const [editWebhookEnabled, setEditWebhookEnabled] = useState(false);
  const [editSkipTier2, setEditSkipTier2] = useState(false);
  const [editHostedMode, setEditHostedMode] = useState(false);

  const openEditor = (repo: Repository) => {
    setEditingRepo(repo);
    const mode: "ssh" | "pat" = repo.patCipher ? "pat" : "ssh";
    setEditMode(mode);
    setEditCloneUrl(repo.cloneUrl || "");
    setEditCloneUrlHttps(repo.cloneUrlHttps || "");
    setEditDeployKey("");
    setEditPat("");
    setEditWebhookEnabled(repo.webhookEnabled ?? false);
    setEditSkipTier2(repo.skipTier2 ?? false);
    setEditHostedMode(repo.hostedMode ?? false);
    setErrorFeedback(null);
    setShowEditRepoModal(true);
  };

  const closeEditor = () => {
    setShowEditRepoModal(false);
    setEditingRepo(null);
    setErrorFeedback(null);
  };

  const handleEditRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRepo) return;

    const prevProvider = editingRepo.provider || "local";
    const urlChanged =
      editCloneUrl !== (editingRepo.cloneUrl || "") ||
      editCloneUrlHttps !== (editingRepo.cloneUrlHttps || "");
    const modeChanged = editMode !== prevProvider;

    // For existing local repos, only send mode if a cloneUrl is provided
    // so the repo transitions to remote; otherwise omit mode to leave it untouched.
    const isExistingLocal = prevProvider === "local";

    try {
      const res = await fetch(`/api/repos/${editingRepo.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: isExistingLocal && !editCloneUrl.trim() ? undefined : editMode,
          cloneUrl: editCloneUrl.trim() || undefined,
          cloneUrlHttps: editCloneUrlHttps.trim() || undefined,
          deployKey: editMode === "ssh" && editDeployKey ? editDeployKey : undefined,
          pat: editMode === "pat" && editPat ? editPat : undefined,
          webhookEnabled: editWebhookEnabled,
          skipTier2: editSkipTier2,
          hostedMode: editHostedMode,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorFeedback(data.error || "Failed to save changes.");
        return;
      }

      const webhookTouched = modeChanged || urlChanged;
      await onUpdated();
      closeEditor();

      if (webhookTouched) {
        onWebhookPrompt({
          id: editingRepo.id,
          name: editingRepo.name,
          hasPat: editMode === "pat" && Boolean(editPat),
        });
      }
    } catch (err: any) {
      setErrorFeedback("Server connection lost: " + err.message);
    }
  };

  return {
    editingRepo,
    showEditRepoModal,
    openEditor,
    closeEditor,
    handleEditRepo,
    editErrorFeedback: errorFeedback,
    editMode,
    setEditMode,
    editCloneUrl,
    setEditCloneUrl,
    editCloneUrlHttps,
    setEditCloneUrlHttps,
    editDeployKey,
    setEditDeployKey,
    editPat,
    setEditPat,
    editWebhookEnabled,
    setEditWebhookEnabled,
    editSkipTier2,
    setEditSkipTier2,
    editHostedMode,
    setEditHostedMode,
  };
}
