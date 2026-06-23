"use client";
import { useState, useEffect, useRef } from "react";
import type React from "react";
import {
  type ActivityLog,
  type DbConfig,
  type PRFile,
  type PullRequest,
  type Repository,
  type ReviewFinding,
} from "../lib/types";

/**
 * Single source of truth for the dashboard's data state, polling, and
 * CRUD actions. App.tsx consumes this and only owns UI state
 * (sidebar open/closed, active tab).
 *
 * Poll cadence: 15s. The /api/repos/:id/prs endpoint can take 60s+
 * against the Supabase pooler; polling faster than that just stacks
 * up fetches past Chrome's 6-concurrent-per-origin cap, which surfaces
 * as "Failed to fetch" in the console. The in-flight ref below also
 * skips a tick if the previous poll hasn't returned yet.
 */
export function useDashboardData() {
  const pollInFlight = useRef(false);
  // ===== Database configuration =====
  const [dbConfig, setDbConfig] = useState<DbConfig>({
    dialect: "postgresql",
    host: "localhost",
    port: "",
    username: "",
    password: "",
    database: "",
    sqliteFile: "data.db",
  });
  const [dbTestResult, setDbTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dbSaveResult, setDbSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTestingDb, setIsTestingDb] = useState(false);
  const [isSavingDb, setIsSavingDb] = useState(false);
  const [dbStatus, setDbStatus] = useState<"configured" | "unconfigured" | "unknown">("unknown");

  // ===== Repositories & PRs =====
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [selectedPrId, setSelectedPrId] = useState<string>("");
  const [prFiles, setPrFiles] = useState<PRFile[]>([]);
  const [selectedFilename, setSelectedFilename] = useState<string>("");
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);

  // ===== Scan / UI feedback =====
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ count: number; model: string; notice?: string | null } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // ===== Add-repo modal form state =====
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoPath, setNewRepoPath] = useState("");
  const [newRepoMode, setNewRepoMode] = useState<"ssh" | "pat">("ssh");
  const [newCloneUrl, setNewCloneUrl] = useState("");
  const [newCloneUrlHttps, setNewCloneUrlHttps] = useState("");
  const [newDeployKey, setNewDeployKey] = useState("");
  const [newPat, setNewPat] = useState("");
  const [newBaseBranch, setNewBaseBranch] = useState("main");
  const [newTriggerMode, setNewTriggerMode] = useState<"auto" | "mention">("auto");
  const [newQuietPeriod, setNewQuietPeriod] = useState(10);
  const [newBranchPattern, setNewBranchPattern] = useState("feature/*");
  const [errorFeedback, setErrorFeedback] = useState<string | null>(null);
  const [lastRegisteredRepo, setLastRegisteredRepo] = useState<{ id: string; name: string; hasPat: boolean } | null>(null);

  // ===== Fetchers =====
  const fetchDbConfig = async () => {
    try {
      const res = await fetch("/api/db/config");
      if (res.ok) {
        const data = await res.json();
        setDbConfig({
          dialect: data.dialect || "postgresql",
          host: data.host || "",
          port: data.port || "",
          username: data.username || "",
          password: "",
          database: data.database || "",
          sqliteFile: data.sqliteFile || "data.db",
        });
        setDbStatus(data.configured ? "configured" : "unconfigured");
      }
    } catch (e) {
      console.error("Failed loading database config:", e);
    }
  };

  const fetchRepos = async () => {
    try {
      const res = await fetch("/api/repos");
      const data = await res.json();
      if (Array.isArray(data)) {
        setRepos(data);
        // Reset selection if it points at a repo that no longer exists
        // (covers the "greploop-core" bootstrap default and deleted repos).
        if (data.length > 0) {
          const stillExists = data.some((r: Repository) => r.id === selectedRepoId);
          if (!selectedRepoId || !stillExists) {
            setSelectedRepoId(data[0].id);
          }
        }
      }
    } catch (e) {
      console.error("Failed loading repositories", e);
    }
  };

  const fetchPrsForSelectedRepo = async (repoId: string, retainSelection = true) => {
    try {
      const res = await fetch(`/api/repos/${repoId}/prs`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setPrs(data);
        if (data.length > 0) {
          setSelectedPrId((prev) => {
            if (retainSelection && prev && data.some((p: PullRequest) => p.id === prev)) {
              return prev;
            }
            return data[0].id;
          });
        } else {
          setSelectedPrId("");
          setPrFiles([]);
          setFindings([]);
        }
      }
    } catch (e) {
      console.error("Failed loading PR list for repo " + repoId, e);
    }
  };

  const fetchPrDetails = async (prId: string) => {
    if (!prId) return;
    try {
      const filesRes = await fetch(`/api/prs/${prId}/files`);
      const filesData = await filesRes.json();
      if (Array.isArray(filesData)) {
        setPrFiles(filesData);
        if (filesData.length > 0) {
          setSelectedFilename((prev) => {
            const stillExists = filesData.some((f: PRFile) => f.filename === prev);
            return stillExists ? prev : filesData[0].filename;
          });
        } else {
          setSelectedFilename("");
        }
      }

      const findingsRes = await fetch(`/api/prs/${prId}/findings`);
      const findingsData = await findingsRes.json();
      if (Array.isArray(findingsData)) {
        setFindings(findingsData);
      }
    } catch (e) {
      console.error("Failed retrieving PR files/findings detailed block", e);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch("/api/reviews");
      const data = await res.json();
      if (Array.isArray(data)) {
        const mappedLogs: ActivityLog[] = data.map((item: any) => ({
          id: `review-${item.id}`,
          action: item.status === "done" ? "AI Review Scanned" : "Daemon Initialized",
          target: `${item.repoName} (${item.branch})`,
          time: new Date(item.timestamp).toLocaleTimeString(),
          status: "done",
        }));
        setLogs(mappedLogs);
      }
    } catch (e) {
      console.error("Failed fetching review history logs", e);
    }
  };

  // ===== Initial load =====
  useEffect(() => {
    fetchRepos();
    fetchLogs();
    fetchDbConfig();
  }, []);

  // Fetch PRs + details immediately when selection changes (no polling reset).
  useEffect(() => {
    const t = setTimeout(() => {
      if (selectedRepoId) fetchPrsForSelectedRepo(selectedRepoId, true);
      if (selectedPrId) fetchPrDetails(selectedPrId);
    }, 50);
    return () => clearTimeout(t);
  }, [selectedRepoId, selectedPrId]);

  // Stable background poller — never resets on selection changes.
  // Uses refs so the interval doesn't need to recreate.
  const repoIdRef = useRef(selectedRepoId);
  const prIdRef = useRef(selectedPrId);
  repoIdRef.current = selectedRepoId;
  prIdRef.current = selectedPrId;

  useEffect(() => {
    const poller = setInterval(async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        await Promise.all([
          fetchRepos(),
          fetchLogs(),
          repoIdRef.current ? fetchPrsForSelectedRepo(repoIdRef.current, true) : Promise.resolve(),
          prIdRef.current ? fetchPrDetails(prIdRef.current) : Promise.resolve(),
        ]);
      } finally {
        pollInFlight.current = false;
      }
    }, 15000);

    return () => clearInterval(poller);
  }, []);

  // ===== DB actions =====
  const handleTestDbConnection = async () => {
    setIsTestingDb(true);
    setDbTestResult(null);
    try {
      const res = await fetch("/api/db/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dbConfig),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setDbTestResult({ success: true, message: "Connected. SELECT 1 returned successfully from the configured pool." });
      } else {
        setDbTestResult({ success: false, message: data.error || "Connection failed. Check the connection string, credentials, and network reachability." });
      }
    } catch (err: any) {
      setDbTestResult({ success: false, message: "Network or Server Error: " + err.message });
    } finally {
      setIsTestingDb(false);
    }
  };

  const handleSaveDbConfig = async () => {
    setIsSavingDb(true);
    setDbSaveResult(null);
    try {
      const res = await fetch("/api/db/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dbConfig),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const msg = data.message || "Saved. Restart the dev server to apply.";
        setDbSaveResult({ success: true, message: msg });
        await fetchDbConfig();
      } else {
        setDbSaveResult({ success: false, message: data.error || "Failed applying config." });
      }
    } catch (err: any) {
      setDbSaveResult({ success: false, message: "Network or Server Error: " + err.message });
    } finally {
      setIsSavingDb(false);
    }
  };

  // ===== PR scan =====
  const handleTriggerPrScan = async () => {
    if (!selectedPrId) return;
    console.log(`[scan] handleTriggerPrScan: starting scan for prId=${selectedPrId}`);
    setIsScanning(true);
    setScanResult(null);

    setPrs((prev) =>
      prev.map((p) => (p.id === selectedPrId ? { ...p, status: "In Progress" } : p)),
    );

    const activeRepoName = repos.find((r) => r.id === selectedRepoId)?.name || selectedRepoId;

    try {
      console.log(`[scan] handleTriggerPrScan: POST /api/prs/${selectedPrId}/scan`);
      const res = await fetch(`/api/prs/${selectedPrId}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: activeRepoName,
        }),
      });

      const result = await res.json();
      console.log(`[scan] handleTriggerPrScan: response status=${res.status}, findings=${result.findings?.length}, rating=${result.rating}, model=${result.usedModel}`);
      if (res.ok) {
        setScanResult({
          count: result.findings?.length || 0,
          model: result.usedModel,
          notice: result.systemWarn,
        });
        console.log(`[scan] handleTriggerPrScan: refetching PR details, PRs, repos, logs`);
        await fetchPrDetails(selectedPrId);
        if (selectedRepoId) await fetchPrsForSelectedRepo(selectedRepoId, true);
        await fetchRepos();
        await fetchLogs();
        console.log(`[scan] handleTriggerPrScan: refetch complete`);
      } else if (res.status === 409 && result.error === "INDEX_REQUIRED") {
        setPrs((prev) =>
          prev.map((p) => (p.id === selectedPrId ? { ...p, status: "Pending" } : p)),
        );
        alert(
          result.message ||
            "Codebase not indexed. Open the Codebase AST graph tab and run the indexer before reviewing.",
        );
      } else {
        setPrs((prev) =>
          prev.map((p) => (p.id === selectedPrId ? { ...p, status: "Failed" } : p)),
        );
        alert("Pipeline Scan Error: " + (result.error || "Execution timeout"));
      }
    } catch (e: any) {
      console.error("Scan dispatch crash", e);
      setPrs((prev) =>
        prev.map((p) => (p.id === selectedPrId ? { ...p, status: "Failed" } : p)),
      );
      alert("Pipeline Dispatch Crashed: " + e.message);
    } finally {
      setIsScanning(false);
    }
  };

  // ===== Add repo =====
  const handleAddRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim()) {
      setErrorFeedback("Project Name is required.");
      return;
    }

    if (!newRepoPath.trim() && !newCloneUrl.trim()) {
      setErrorFeedback("Either Directory Path or Clone URL is required.");
      return;
    }

    const mode = newRepoPath.trim() ? "local" : newRepoMode;

    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          name: newRepoName.trim(),
          path: newRepoPath.trim() || undefined,
          cloneUrl: newCloneUrl.trim() || undefined,
          cloneUrlHttps: newCloneUrlHttps.trim() || undefined,
          deployKey: newDeployKey || undefined,
          pat: newPat || undefined,
          baseBranch: newBaseBranch,
          triggerMode: newTriggerMode,
          quietPeriodSeconds: Number(newQuietPeriod),
          branchPattern: newBranchPattern,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setShowAddRepoModal(false);
        setErrorFeedback(null);
        await fetchRepos();
        setSelectedRepoId(data.id);
        await fetchPrsForSelectedRepo(data.id, false);

        if (mode !== "local") {
          setLastRegisteredRepo({ id: data.id, name: newRepoName.trim(), hasPat: !!newPat });
          setNewRepoMode("ssh");
          setNewCloneUrl("");
          setNewCloneUrlHttps("");
          setNewDeployKey("");
          setNewPat("");
        }
        setNewRepoName("");
        setNewRepoPath("");
      } else {
        setErrorFeedback(data.error || "Failed linking project.");
      }
    } catch (err: any) {
      setErrorFeedback("Server connection lost: " + err.message);
    }
  };

  // ===== Daemon callback =====
  const handleTriggerReviewPass = () => {
    fetchRepos();
    fetchLogs();
    if (selectedRepoId) fetchPrsForSelectedRepo(selectedRepoId, true);
    if (selectedPrId) fetchPrDetails(selectedPrId);
  };

  // ===== Markdown export =====
  const handleExportMarkdown = () => {
    const activePr = prs.find((p) => p.id === selectedPrId);
    const activeRepo = repos.find((r) => r.id === selectedRepoId);
    if (!activePr || !activeRepo) return;

    let mdContent = `# GrepLoop automated PR Code Review Summary Card\n\n`;
    mdContent += `### System Details:\n`;
    mdContent += `- **Project:** \`${activeRepo.name}\`\n`;
    mdContent += `- **Pull Request:** \`${activePr.title}\`\n`;
    mdContent += `- **Source Branch:** \`${activePr.sourceBranch}\` \`(${activePr.commitHash})\`\n`;
    mdContent += `- **Target/Base Branch:** \`${activePr.targetBranch}\`\n`;
    mdContent += `- **Author Name:** \`${activePr.author}\`\n`;
    mdContent += `- **Scanned On (UTC):** \`${new Date().toISOString()}\`\n`;
    mdContent += `- **Core Policy Stack:** Compliance GrepLoop Guard v4\n\n`;
    mdContent += `--- \n\n`;

    mdContent += `## Files Checked in Pull Request:\n`;
    prFiles.forEach((file) => {
      mdContent += `- **File:** \`${file.filename}\` (\`+${file.additions}\` additions, \`-${file.deletions}\` deletions)\n`;
    });
    mdContent += `\n`;

    mdContent += `## Review Findings and Severity Alerts:\n\n`;

    if (findings.length === 0) {
      mdContent += `🎉 **Perfect PR Pass!** No bugs, performance leaks, or security vulnerabilities discovered for this diff block.\n`;
    } else {
      findings.forEach((find, idx) => {
        mdContent += `### [${idx + 1}] Severity: **${find.severity.toUpperCase()}** • Category: **${find.category}**\n`;
        mdContent += `- **Location:** \`${find.filename}\` (Line ${find.line})\n`;
        mdContent += `- **Observation Detail:** ${find.explanation}\n`;
        if (find.diffSuggestion) {
          mdContent += `\n**Proposed Resolution:**\n`;
          mdContent += `\`\`\`rust\n${find.diffSuggestion}\n\`\`\`\n`;
        }
        mdContent += `\n---\n\n`;
      });
    }

    mdContent += `\n\n_Auto compiled by GrepLoop daemon - Local-First PR review agent._`;

    const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${activeRepo.name}-${activePr.sourceBranch.replace(/\//g, "-")}-review-card.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleCopyCode = (text: string, pathId: string) => {
    try {
      navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopyFeedback(pathId);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  return {
    // db config
    dbConfig,
    setDbConfig,
    dbStatus,
    dbTestResult,
    dbSaveResult,
    isTestingDb,
    isSavingDb,
    handleTestDbConnection,
    handleSaveDbConfig,
    // repos + prs
    repos,
    selectedRepoId,
    setSelectedRepoId,
    prs,
    selectedPrId,
    setSelectedPrId,
    prFiles,
    selectedFilename,
    setSelectedFilename,
    findings,
    logs,
    fetchPrsForSelectedRepo,
    // scan
    isScanning,
    scanResult,
    setScanResult,
    handleTriggerPrScan,
    handleExportMarkdown,
    handleCopyCode,
    copyFeedback,
    // add repo modal
    showAddRepoModal,
    setShowAddRepoModal,
    newRepoName,
    setNewRepoName,
    newRepoPath,
    setNewRepoPath,
    newRepoMode,
    setNewRepoMode,
    newCloneUrl,
    setNewCloneUrl,
    newCloneUrlHttps,
    setNewCloneUrlHttps,
    newDeployKey,
    setNewDeployKey,
    newPat,
    setNewPat,
    newBaseBranch,
    setNewBaseBranch,
    newBranchPattern,
    setNewBranchPattern,
    newTriggerMode,
    setNewTriggerMode,
    newQuietPeriod,
    setNewQuietPeriod,
    errorFeedback,
    setErrorFeedback,
    handleAddRepo,
    lastRegisteredRepo,
    setLastRegisteredRepo,
    // daemon callback
    handleTriggerReviewPass,
  };
}
