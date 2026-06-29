"use client";
import { useState, useEffect, useRef } from "react";
import type React from "react";
import {
  type ActivityLog,
  type DbConfig,
  type PRFile,
  type PullRequest,
  type Repository,
  type ReviewChunk,
  type ReviewFinding,
} from "../lib/types";
import { fetchJson } from "../lib/http";

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
  const latestPrsRequest = useRef(0);
  const latestDetailsRequest = useRef(0);
  // True between handleTriggerPrScan's first await and its finally block.
  // The isScanning-sync useEffect below reads this — when a scan request
  // is in flight, the 15s poller can return server data where PR.status
  // is still "Pending" (backend hasn't reached the status update yet —
  // refreshPrFiles + indexFolder run first), which would otherwise flip
  // isScanning back to false mid-scan. That makes the UI show old findings
  // and re-enable the button, so the user clicks again → 409
  // SCAN_IN_PROGRESS from the still-running first request. Holding the
  // optimistic state until the request settles closes that window.
  const scanInFlightRef = useRef(false);
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
  const [reviewRun, setReviewRun] = useState<{
    id: string;
    commitHash: string;
    diffHash: string;
    completedAt: string | null;
    rating: number | null;
    model: string | null;
    triggerReason: string | null;
    reliability?: string | null;
    chunksTotal?: number;
    chunksCompleted?: number;
    chunksFailed?: number;
    chunksSkipped?: number;
  } | null>(null);
  const [reviewChunks, setReviewChunks] = useState<ReviewChunk[]>([]);
  // Currently in-progress scan (null when no scan is active). The findings
  // endpoint returns this in parallel with the latest COMPLETED reviewRun
  // so the UI can render live chunk progress + poll iteration logs while
  // the agentic loop is still running, instead of just a spinner.
  const [activeScan, setActiveScan] = useState<{
    id: string;
    prId: string;
    commitHash: string;
    diffHash: string;
    startedAt: string;
    triggerReason: string | null;
    model: string | null;
    chunksTotal?: number;
    chunksCompleted?: number;
    chunksFailed?: number;
    chunksSkipped?: number;
  } | null>(null);
  const [activeScanChunks, setActiveScanChunks] = useState<ReviewChunk[]>([]);
  // Partial findings persisted from completed chunks of the active scan.
  // Lets the UI render "found so far" while the scan is still running.
  const [activeFindings, setActiveFindings] = useState<ReviewFinding[]>([]);
  // Per-chunk agentic-loop progress: { current: N, max: M } keyed by
  // chunkId (or "__run" for non-chunked scans). Source: ReviewLog rows
  // matching "Iteration N/M — ModelName" — see reviewFreshness.getActiveScan.
  const [activeIterations, setActiveIterations] = useState<Record<string, { current: number; max: number }>>({});
  const [rejectedCount, setRejectedCount] = useState(0);
  const [rejectedFindings, setRejectedFindings] = useState<Array<{
    id: string; filename: string; line: number | null;
    severity: string; category: string; explanation: string;
    verificationNote: string | null;
  }>>([]);
  const [stale, setStale] = useState(false);
  const [logs, setLogs] = useState<ActivityLog[]>([]);

  // ===== Scan / UI feedback =====
  const [isScanning, setIsScanning] = useState(false);
  const [isRetryingChunks, setIsRetryingChunks] = useState(false);
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
      const res = await fetchJson("/api/db/config");
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
      const res = await fetchJson("/api/repos");
      const data = await res.json();
      if (Array.isArray(data)) {
        setRepos(data);
        // Reset selection if it points at a repo that no longer exists
        // (covers the "dragnet-core" bootstrap default and deleted repos).
        //
        // Read current selection from a ref, not the state closure. The
        // background poller (below) captures the FIRST render's fetchRepos,
        // which closes over selectedRepoId="" — reading the state directly
        // here would always see "" and force selection back to data[0]
        // every 15 seconds ("bam! another project opens" symptom).
        const currentSelected = repoIdRef.current;
        if (data.length > 0) {
          const stillExists = data.some((r: Repository) => r.id === currentSelected);
          if (!currentSelected || !stillExists) {
            setSelectedRepoId(data[0].id);
          }
        }
      }
    } catch (e) {
      console.error("Failed loading repositories", e);
    }
  };

  const fetchPrsForSelectedRepo = async (repoId: string, retainSelection = true) => {
    const requestId = ++latestPrsRequest.current;
    if (!retainSelection) {
      latestDetailsRequest.current += 1;
      setPrs([]);
      setSelectedPrId("");
      setPrFiles([]);
      setSelectedFilename("");
      setFindings([]);
      setReviewRun(null);
      setReviewChunks([]);
      setActiveScan(null);
      setActiveScanChunks([]);
      setActiveFindings([]);
      setActiveIterations({});
      setRejectedCount(0);
      setRejectedFindings([]);
      setStale(false);
    }

    try {
      const res = await fetchJson(`/api/repos/${repoId}/prs`);
      const data = await res.json();
      if (requestId !== latestPrsRequest.current) return;

      const prsData = Array.isArray(data) && data.length === 0
        ? await refreshPrsAfterEmptySnapshot(repoId, requestId)
        : data;
      if (requestId !== latestPrsRequest.current) return;

      if (Array.isArray(prsData)) {
        if (retainSelection && prs.length > 0 && prsData.length === 0) {
          return;
        }
        setPrs(prsData);
        if (prsData.length > 0) {
          setSelectedPrId((prev) => {
            if (retainSelection && prev && prsData.some((p: PullRequest) => p.id === prev)) {
              return prev;
            }
            return prsData[0].id;
          });
        } else {
          setSelectedPrId("");
          setPrFiles([]);
          setFindings([]);
          setReviewRun(null);
          setReviewChunks([]);
          setActiveScan(null);
          setActiveScanChunks([]);
          setActiveFindings([]);
          setActiveIterations({});
        }
      }
    } catch (e) {
      console.error("Failed loading PR list for repo " + repoId, e);
    }
  };

  const refreshPrsAfterEmptySnapshot = async (repoId: string, requestId: number) => {
    try {
      const refreshRes = await fetchJson(`/api/repos/${repoId}/prs`, { method: "POST" });
      const refreshData = await refreshRes.json();
      if (requestId !== latestPrsRequest.current) return [];
      return Array.isArray(refreshData) ? refreshData : [];
    } catch (err) {
      console.warn("Failed refreshing empty PR snapshot for repo " + repoId, err);
      return [];
    }
  };

  const fetchPrDetails = async (prId: string, clearBeforeLoad = true) => {
    if (!prId) return;
    const requestId = ++latestDetailsRequest.current;
    if (clearBeforeLoad) {
      setPrFiles([]);
      setSelectedFilename("");
      setFindings([]);
      setReviewRun(null);
      setReviewChunks([]);
      setActiveScan(null);
      setActiveScanChunks([]);
      setActiveFindings([]);
      setActiveIterations({});
      setRejectedCount(0);
      setRejectedFindings([]);
      setStale(false);
    }
    try {
      const filesRes = await fetchJson(`/api/prs/${prId}/files`);
      const filesData = await filesRes.json();
      if (requestId !== latestDetailsRequest.current) return;
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

      const findingsRes = await fetchJson(`/api/prs/${prId}/findings`);
      const findingsData = await findingsRes.json();
      if (requestId !== latestDetailsRequest.current) return;
      if (findingsData && typeof findingsData === "object" && "findings" in findingsData) {
        setFindings(findingsData.findings);
        setReviewRun(findingsData.reviewRun ?? null);
        setReviewChunks(findingsData.chunks ?? []);
        setActiveScan(findingsData.activeScan ?? null);
        setActiveScanChunks(findingsData.activeChunks ?? []);
        setActiveFindings(findingsData.activeFindings ?? []);
        setActiveIterations(findingsData.activeIterations ?? {});
        setRejectedCount(findingsData.rejectedCount ?? 0);
        setRejectedFindings(findingsData.rejectedFindings ?? []);
        setStale(Boolean(findingsData.stale));
        if (findingsData.sizeProfile) {
          setPrs((prev) =>
            prev.map((p) => (p.id === prId ? { ...p, sizeProfile: findingsData.sizeProfile } : p)),
          );
        }
      } else if (Array.isArray(findingsData)) {
        // Backward compat with older route shape.
        setFindings(findingsData);
        setReviewRun(null);
        setReviewChunks([]);
        setActiveScan(null);
        setActiveScanChunks([]);
        setActiveFindings([]);
        setActiveIterations({});
        setRejectedCount(0);
        setRejectedFindings([]);
        setStale(false);
      }
    } catch (e) {
      console.error("Failed retrieving PR files/findings detailed block", e);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetchJson("/api/reviews");
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

  // Clear stale scan state IMMEDIATELY when selection changes — before the
  // 50ms-debounced fetch below fires. Without this, switching PRs while a
  // scan is running on the previous PR leaves activeScan pointing at the
  // old run, which makes ReviewProgress poll the old run's logs into the
  // new view. fetchPrDetails/fetchPrsForSelectedRepo also clear this state
  // on the server side, but they're async + debounced; this effect runs
  // synchronously on selection change so the UI never renders stale data.
  useEffect(() => {
    setActiveScan(null);
    setActiveScanChunks([]);
    setActiveFindings([]);
    setActiveIterations({});
  }, [selectedRepoId, selectedPrId]);

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
          // clearBeforeLoad=false: keep the previous findings visible while
          // the refetch is in flight. Otherwise the report flashes empty every
          // 15s, making it impossible to copy from mid-render.
          prIdRef.current ? fetchPrDetails(prIdRef.current, false) : Promise.resolve(),
        ]);
      } finally {
        pollInFlight.current = false;
      }
    }, 15000);

    return () => clearInterval(poller);
  }, []);

  // Sync isScanning with the selected PR's status — covers scans triggered
  // from any source (UI button, /dragnet skill, prepush hook, curl). The
  // button-click path stays optimistic because handleTriggerPrScan
  // immediately sets PR.status to "In Progress" in local state, so this
  // effect agrees with the optimistic value rather than fighting it.
  //
  // The activeScan check closes a second gap: between the user click and
  // the scan route's prisma.pullRequest.updateMany({status: 'In Progress'})
  // (which runs AFTER refreshPrFiles + indexFolder + cache check), the
  // PR row in the DB still says "Pending". The findings endpoint returns
  // activeScan as soon as the ReviewRun row exists, so checking both
  // catches scans that the PR.status alone would miss.
  //
  // scanInFlightRef: while the user's own POST /scan is pending, ignore
  // stale server state. Without this, the 15s poller races the request
  // and flips isScanning=false mid-prep, the UI flips back to "ready"
  // with the previous findings, the user re-clicks, and the second
  // request 409s on the still-running first one.
  useEffect(() => {
    if (!selectedPrId) return;
    if (scanInFlightRef.current) return;
    const activePR = prs.find((p) => p.id === selectedPrId);
    if (!activePR) return;
    // Scope the activeScan check to the selected PR. The /findings endpoint
    // returns activeScan per-prId, so it SHOULD always match selectedPrId —
    // but during selection transitions, stale state can leave activeScan
    // pointing at the previously-selected PR's run. The prId guard rejects
    // that, so isScanning can't be forced true by a foreign run.
    const activeScanIsForSelectedPr = !!activeScan && activeScan.prId === selectedPrId;
    setIsScanning(activePR.status === "In Progress" || activeScanIsForSelectedPr);
  }, [selectedPrId, prs, activeScan]);

  // ===== DB actions =====
  const handleTestDbConnection = async () => {
    setIsTestingDb(true);
    setDbTestResult(null);
    try {
      const res = await fetchJson("/api/db/test", {
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
      const res = await fetchJson("/api/db/config", {
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
    const scanningPrId = selectedPrId;
    const scanningRepoId = selectedRepoId;
    console.log(`[scan] handleTriggerPrScan: starting scan for prId=${scanningPrId}`);
    scanInFlightRef.current = true;
    setIsScanning(true);
    setScanResult(null);
    setStale(false);

    // Optimistic clear of the prior completed run so the UI instantly
    // flips to "scanning" instead of showing the stale rating + findings
    // for the ~1-10s window between click and the scan endpoint actually
    // returning (and the subsequent /findings poll picking up the new
    // in-progress run). Without this, users briefly see the old results
    // and assume the new scan was instant — wastes 10+ min before they
    // realise the AI is re-reporting identical findings. Mirrors the
    // reset block in fetchPrDetails(clearBeforeLoad=true) below.
    setFindings([]);
    setReviewRun(null);
    setReviewChunks([]);
    setActiveScan(null);
    setActiveScanChunks([]);
    setActiveFindings([]);
    setActiveIterations({});
    setRejectedCount(0);
    setRejectedFindings([]);

    setPrs((prev) =>
      prev.map((p) => (p.id === scanningPrId ? { ...p, status: "In Progress" } : p)),
    );

    const activeRepoName = repos.find((r) => r.id === scanningRepoId)?.name || scanningRepoId;

    try {
      console.log(`[scan] handleTriggerPrScan: POST /api/prs/${scanningPrId}/scan`);
      const res = await fetchJson(`/api/prs/${scanningPrId}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: activeRepoName,
        }),
      });

      const result = await res.json();
      console.log(`[scan] handleTriggerPrScan: response status=${res.status}, findings=${result.findings?.length}, rating=${result.rating}, model=${result.usedModel}`);
      if (res.ok) {
        if (result.sizeProfile) {
          setPrs((prev) =>
            prev.map((p) => (p.id === scanningPrId ? { ...p, sizeProfile: result.sizeProfile } : p)),
          );
        }
        setScanResult({
          count: result.findings?.length || 0,
          model: result.usedModel,
          notice: result.systemWarn,
        });
        console.log(`[scan] handleTriggerPrScan: refetching PR details, PRs, repos, logs`);
        setSelectedRepoId(scanningRepoId);
        setSelectedPrId(scanningPrId);
        await fetchPrDetails(scanningPrId, false);
        if (scanningRepoId) await fetchPrsForSelectedRepo(scanningRepoId, true);
        await fetchRepos();
        await fetchLogs();
        console.log(`[scan] handleTriggerPrScan: refetch complete`);
      } else if (res.status === 409 && result.error === "INDEX_REQUIRED") {
        setPrs((prev) =>
          prev.map((p) => (p.id === scanningPrId ? { ...p, status: "Pending" } : p)),
        );
        alert(
          result.message ||
            "Codebase not indexed. Open the Codebase AST graph tab and run the indexer before reviewing.",
        );
      } else {
        setPrs((prev) =>
          prev.map((p) => (p.id === scanningPrId ? { ...p, status: "Failed" } : p)),
        );
        alert("Pipeline Scan Error: " + (result.error || "Execution timeout"));
      }
    } catch (e: any) {
      console.error("Scan dispatch crash", e);
      setPrs((prev) =>
        prev.map((p) => (p.id === scanningPrId ? { ...p, status: "Failed" } : p)),
      );
      alert("Pipeline Dispatch Crashed: " + e.message);
    } finally {
      // Clear the in-flight ref BEFORE re-syncing so the isScanning
      // useEffect (which reads scanInFlightRef.current) is allowed to
      // run again — otherwise we'd suppress the post-request re-sync
      // we're about to trigger by touching prs.
      scanInFlightRef.current = false;
      setIsScanning(false);
    }
  };

  const handleRetryFailedChunks = async () => {
    if (!selectedPrId) return;
    // The LargePrModePanel renders against activeScan while a scan is in
    // progress and against reviewRun afterwards. Match that source of truth
    // here — otherwise a first-time stuck scan has reviewRun=null and this
    // handler silently no-ops, and a re-scan stuck mid-flight sends the POST
    // to the PREVIOUS completed runId ("Nothing to resume"). Prefer activeScan
    // when present, fall back to reviewRun for the after-the-fact retry case.
    const runId = activeScan?.id ?? reviewRun?.id;
    if (!runId) return;
    setIsRetryingChunks(true);
    try {
      const res = await fetchJson(`/api/prs/${selectedPrId}/runs/${runId}/retry-failed-chunks`, {
        method: "POST",
      });
      const result = await res.json();
      if (!res.ok) {
        alert("Retry Failed Chunks Error: " + (result.error || "Execution timeout"));
        return;
      }
      setScanResult({
        count: result.findings?.length || 0,
        model: result.usedModel || "large-pr-mode",
        notice: result.systemWarn,
      });
      await fetchPrDetails(selectedPrId, false);
      if (selectedRepoId) await fetchPrsForSelectedRepo(selectedRepoId, true);
      await fetchRepos();
      await fetchLogs();
    } catch (err: any) {
      alert("Retry Failed Chunks Crashed: " + err.message);
    } finally {
      setIsRetryingChunks(false);
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
      const res = await fetchJson("/api/repos", {
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
    // clearBeforeLoad=false: same reason as the background poller — don't
    // wipe the report during the refetch window.
    if (selectedPrId) fetchPrDetails(selectedPrId, false);
  };

  // ===== Markdown export =====
  // Two paths share the server-side builder so output stays byte-identical:
  //   - format="file"     writes to .dragnet/reviews/<slug>/<runId>.md
  //   - format="download" returns the markdown inline; client wraps in a Blob
  //                      and triggers a browser download (legacy path).
  const [exportStatus, setExportStatus] = useState<{
    kind: "file" | "download";
    success: boolean;
    message: string;
  } | null>(null);

  const handleExportMarkdown = async (format: "file" | "download" = "download") => {
    if (!selectedPrId) return;
    if (!reviewRun?.id) {
      setExportStatus({
        kind: format,
        success: false,
        message: "No completed review run to export.",
      });
      return;
    }
    setExportStatus(null);
    try {
      const res = await fetchJson(
        `/api/prs/${selectedPrId}/runs/${reviewRun.id}/export-markdown`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format }),
        },
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Export failed (HTTP ${res.status}).`);
      }
      if (format === "file") {
        setExportStatus({
          kind: "file",
          success: true,
          message: `Saved to ${data.relPath}`,
        });
      } else {
        // Server returned the markdown inline; trigger a browser download.
        const blob = new Blob([data.markdown], { type: "text/markdown;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", data.filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setExportStatus({
          kind: "download",
          success: true,
          message: "Downloaded.",
        });
      }
    } catch (err: any) {
      setExportStatus({
        kind: format,
        success: false,
        message: err?.message || "Export failed.",
      });
    }
    // Auto-clear the status pill after 6s.
    setTimeout(() => setExportStatus(null), 6000);
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
    reviewRun,
    reviewChunks,
    activeScan,
    activeScanChunks,
    activeFindings,
    activeIterations,
    rejectedCount,
    rejectedFindings,
    stale,
    logs,
    fetchPrsForSelectedRepo,
    // scan
    isScanning,
    isRetryingChunks,
    scanResult,
    setScanResult,
    handleTriggerPrScan,
    handleRetryFailedChunks,
    handleExportMarkdown,
    exportStatus,
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
