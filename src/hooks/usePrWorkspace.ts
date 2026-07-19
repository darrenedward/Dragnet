"use client";

import { useEffect, useRef, useState } from "react";
import type { Repository } from "../lib/types";
import { PrWorkspaceCoordinator } from "../lib/prWorkspaceCoordinator";

interface UsePrWorkspaceOptions {
  repos: Repository[];
}

/**
 * Browser-facing selection boundary for the PR review workspace.
 *
 * Repository catalog state stays in useDashboardData; this hook owns the
 * active review context and exposes the request coordinator used by its
 * read/refresh commands. That keeps repository registration separate from
 * the user's current PR workspace.
 */
export function usePrWorkspace({ repos }: UsePrWorkspaceOptions) {
  const coordinator = useRef(new PrWorkspaceCoordinator());
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [selectedPrId, setSelectedPrId] = useState("");

  useEffect(() => {
    setSelectedRepoId((current) => {
      const next = coordinator.current.selectPr(current, repos.map((repo) => repo.id));
      if (next !== current) setSelectedPrId("");
      return next;
    });
  }, [repos]);

  const selectRepository = (repoId: string) => {
    setSelectedRepoId(repoId);
    setSelectedPrId("");
  };

  const selectPullRequest = (prId: string) => {
    setSelectedPrId(prId);
  };

  return {
    coordinator,
    selectedRepoId,
    selectedPrId,
    selectRepository,
    selectPullRequest,
    reconcilePullRequest: (prIds: string[], retainSelection = true) => {
      setSelectedPrId((current) => coordinator.current.selectPr(retainSelection ? current : "", prIds));
    },
  };
}
