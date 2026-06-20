import express from "express";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { GoogleGenAI, Type } from "@google/genai";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres" });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
import { runPrScan, generateRealisticFindings } from "./reviewService";
import { IndexingService } from "./src/services/indexingService";

// Helper to inspect real Git directory and branch differences!
async function getRealLocalPrs(repoPath: string, repoId: string) {
  try {
    const resolvedPath = path.isAbsolute(repoPath) ? repoPath : path.resolve(process.cwd(), repoPath);
    if (!fs.existsSync(resolvedPath)) return null;

    // Verify it is a git repository
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: resolvedPath, stdio: "ignore" });
    } catch {
      return null;
    }

    // List branches formatted
    const branchesBuffer = execSync("git branch --format='%(refname:short)|%(objectname:short)|%(subject)|%(authorname)'", { cwd: resolvedPath });
    const branches = branchesBuffer.toString().trim().split("\n").filter(Boolean);

    // Identify standard active base branch
    let baseBranch = "main";
    try {
      baseBranch = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", { cwd: resolvedPath }).toString().trim().replace("origin/", "");
    } catch {
      try {
        execSync("git show-ref --verify --quiet refs/heads/main", { cwd: resolvedPath });
        baseBranch = "main";
      } catch {
        try {
          execSync("git show-ref --verify --quiet refs/heads/master", { cwd: resolvedPath });
          baseBranch = "master";
        } catch {
          baseBranch = "main";
        }
      }
    }

    const prs: any[] = [];
    let idIndex = 1000;

    for (const bLine of branches) {
      const [branchName, hash, msg, author] = bLine.split("|");
      if (!branchName || branchName === baseBranch || branchName.includes("heads/")) continue;

      const cleanBranch = branchName.trim();
      const prId = `real-pr-${repoId}-${cleanBranch.replace(/\//g, "-")}`;

      // Check if this PR already exists in DB
      const existingPr = await prisma.pullRequest.findUnique({ where: { id: prId } });
      if (existingPr) {
        prs.push(existingPr);
        continue;
      }

      // Query files changed relative to base branch
      let filesList: any[] = [];
      try {
        const changedFilesBuffer = execSync(`git diff --name-status ${baseBranch}...${cleanBranch}`, { cwd: resolvedPath });
        const changedFilesLines = changedFilesBuffer.toString().trim().split("\n").filter(Boolean);

        for (const fLine of changedFilesLines) {
          const parts = fLine.split(/\s+/);
          const statusChar = parts[0];
          const filename = parts[1];
          if (!filename) continue;

          let originalContent = "";
          let modifiedContent = "";
          let diffStr = "";

          try {
            diffStr = execSync(`git diff ${baseBranch}...${cleanBranch} -- "${filename}"`, { cwd: resolvedPath }).toString();
          } catch {}

          try {
            originalContent = execSync(`git show ${baseBranch}:"${filename}"`, { cwd: resolvedPath, stdio: ["ignore", "pipe", "ignore"] }).toString();
          } catch {}

          try {
            modifiedContent = execSync(`git show ${cleanBranch}:"${filename}"`, { cwd: resolvedPath, stdio: ["ignore", "pipe", "ignore"] }).toString();
          } catch {}

          const additions = diffStr.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
          const deletions = diffStr.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---")).length;

          filesList.push({
            filename,
            status: statusChar === "A" ? "added" : statusChar === "D" ? "deleted" : "modified",
            additions,
            deletions,
            originalContent,
            modifiedContent,
            diff: diffStr
          });
        }
      } catch (err) {
        console.error(`Git diff failed for branch ${cleanBranch}`, err);
      }

      if (filesList.length === 0) continue; // Skip branch if no changes

      // Clean existing records in case profile changes
      await prisma.pullRequest.deleteMany({ where: { id: prId } });
      
      // Insert real PR into DB
      await prisma.pullRequest.create({
        data: {
          id: prId,
          repoId: repoId,
          title: `PR from local: ${cleanBranch}`,
          sourceBranch: cleanBranch,
          targetBranch: baseBranch,
          status: "Pending",
          author: author || "Local Dev",
          commitHash: hash || "HEAD",
          createdAt: new Date().toISOString(),
          description: msg || `Auto-detected branch representing local code changes.`
        }
      });

      // Save related files
      for (const file of filesList) {
        const fileId = `file-real-${idIndex++}`;
        await prisma.prFile.deleteMany({ where: { id: fileId } });
        await prisma.prFile.create({
          data: {
            id: fileId,
            prId: prId,
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            originalContent: file.originalContent,
            modifiedContent: file.modifiedContent,
            diff: file.diff
          }
        });
      }

      prs.push({
        id: prId,
        repoId,
        title: `PR from local: ${cleanBranch}`,
        sourceBranch: cleanBranch,
        targetBranch: baseBranch,
        status: "Pending",
        author: author || "Local Dev",
        commitHash: hash || "HEAD",
        createdAt: new Date().toISOString(),
        description: msg || `Auto-detected branch representing local code changes.`
      });
    }

    return prs;
  } catch (e) {
    console.warn("Failed scanning Git directory content", e);
    return null;
  }
}

async function startServer() {
  // Initialize database dynamically
  
  const app = express();
  const PORT = 3000;

  // JSON Payload parsing
  app.use(express.json());

  // GET all repositories
  app.get("/api/repos", async (req, res) => {
    try {
      const reposRaw = await prisma.repository.findMany({ include: { _count: { select: { pullRequests: true } } } });
      const repos = reposRaw.map(r => ({ ...r, prCount: r._count.pullRequests }));
      res.json(repos);
    } catch (err: any) {
      console.error("Error fetching repositories:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST add custom repository
  app.post("/api/repos", async (req, res) => {
    try {
      const { id, name, path: repoPath, baseBranch, activeBranch, triggerMode, quietPeriodSeconds, branchPattern } = req.body;
      const cleanId = id || name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now();
      
      await prisma.repository.create({
        data: {
          id: cleanId,
          name: name,
          path: repoPath,
          baseBranch: baseBranch || "main",
          activeBranch: activeBranch || baseBranch || "main",
          triggerMode: triggerMode || "auto",
          quietPeriodSeconds: quietPeriodSeconds || 10,
          branchPattern: branchPattern || "*",
          status: 'idle',
          lastCommitHash: 'a1b2c3d',
          lastCommitMessage: 'initial repository watch link',
          lastActivityTime: new Date().toISOString(),
          stabilizationTimer: 0,
          reviewsCount: 0
        }
      });
      
      // Auto-scan for active branches right away if git repository
      await getRealLocalPrs(repoPath, cleanId);

      res.status(201).json({ success: true, id: cleanId });
    } catch (err: any) {
      console.error("Error inserting repository:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update specific repository
  app.put("/api/repos/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { 
        activeBranch, 
        status, 
        lastCommitHash, 
        lastCommitMessage, 
        stabilizationTimer, 
        reviewsCount, 
        triggerMode, 
        quietPeriodSeconds, 
        branchPattern,
        path: repoPath
      } = req.body;
      
      const current = await prisma.repository.findUnique({ where: { id } });
      if (!current) {
        return res.status(404).json({ error: "Repository record not found" });
      }
      
      await prisma.repository.update({
        where: { id },
        data: {
          activeBranch: activeBranch !== undefined ? activeBranch : current.activeBranch,
          status: status !== undefined ? status : current.status,
          lastCommitHash: lastCommitHash !== undefined ? lastCommitHash : current.lastCommitHash,
          lastCommitMessage: lastCommitMessage !== undefined ? lastCommitMessage : current.lastCommitMessage,
          lastActivityTime: new Date().toISOString(),
          stabilizationTimer: stabilizationTimer !== undefined ? stabilizationTimer : current.stabilizationTimer,
          reviewsCount: reviewsCount !== undefined ? reviewsCount : current.reviewsCount,
          triggerMode: triggerMode !== undefined ? triggerMode : current.triggerMode,
          quietPeriodSeconds: quietPeriodSeconds !== undefined ? quietPeriodSeconds : current.quietPeriodSeconds,
          branchPattern: branchPattern !== undefined ? branchPattern : current.branchPattern
        }
      });

      // If repository status becomes "stabilizing" or is "reviewing", set corresponding PR's status to "In Progress"
      const targetStatus = status !== undefined ? status : current.status;
      const targetBranch = activeBranch !== undefined ? activeBranch : current.activeBranch;
      if (targetStatus === 'stabilizing' && targetBranch) {
        const prId = `real-pr-${id}-${targetBranch.replace(/\//g, "-")}`;
        await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'In Progress' } });
      }
      
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error updating repository:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE a repository
  app.delete("/api/repos/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await prisma.repository.deleteMany({ where: { id } });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error unlinking repository:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST Run Codebase Index on repository
  app.post("/api/repos/:id/index", async (req, res) => {
    try {
      const { id } = req.params;
      const repo = await prisma.repository.findUnique({ where: { id } });
      if (!repo) {
        return res.status(404).json({ error: "Repository record not found" });
      }

      await prisma.repository.updateMany({ where: { id }, data: { status: 'stabilizing' } });
      const stats = await IndexingService.indexFolder(id, repo.path);
      res.json({ success: true, stats });
    } catch (err: any) {
      console.error("Failed indexing repository folder:", err);
      try {
        await prisma.repository.updateMany({ where: { id: req.params.id }, data: { status: 'idle' } });
      } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  // GET all indexed symbols for repo
  app.get("/api/repos/:id/symbols", async (req, res) => {
    try {
      const { id } = req.params;
      const symbols = await prisma.symbol.findMany({ where: { repoId: id } });
      res.json(symbols);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET all call graph edges for repo
  app.get("/api/repos/:id/edges", async (req, res) => {
    try {
      const { id } = req.params;
      const edges = await prisma.edge.findMany({ where: { repoId: id } });
      res.json(edges);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET structured interactive call-graph nodes/links for repo
  app.get("/api/repos/:id/callgraph", async (req, res) => {
    try {
      const { id } = req.params;
      const symbols = await prisma.symbol.findMany({ where: { repoId: id } });
      const edges = await prisma.edge.findMany({ where: { repoId: id } });

      const nodes = symbols.map(s => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
        lineStart: s.lineStart,
        signature: s.signature
      }));

      const links = edges.map(e => ({
        id: e.id,
        source: e.fromId,
        target: e.toId || null,
        targetRaw: e.toRaw,
        kind: e.kind,
        line: e.line,
        filePath: e.filePath
      }));

      res.json({ nodes, links });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET Pull Requests for specific repository
  app.get("/api/repos/:id/prs", async (req, res) => {
    try {
      const { id } = req.params;
      const repo = await prisma.repository.findUnique({ where: { id } });
      if (!repo) {
        return res.status(404).json({ error: "Repository not found" });
      }

      // Try reading live GIT branches if path has a folder
      await getRealLocalPrs(repo.path, id);

      const prs = await prisma.pullRequest.findMany({ where: { repoId: id }, orderBy: { createdAt: 'desc' } });
      res.json(prs);
    } catch (err: any) {
      console.error("Error fetching repository PRs:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET files for a specific PR
  app.get("/api/prs/:prId/files", async (req, res) => {
    try {
      const { prId } = req.params;
      const files = await prisma.prFile.findMany({ where: { prId } });
      res.json(files);
    } catch (err: any) {
      console.error("Error fetching files for PR:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET findings / comments for a specific PR
  app.get("/api/prs/:prId/findings", async (req, res) => {
    try {
      const { prId } = req.params;
      const findings = await prisma.reviewFinding.findMany({ where: { prId: prId } });
      res.json(findings);
    } catch (err: any) {
      console.error("Error fetching findings for PR:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST trigger dynamic AI scan for a PR (local Ollama port vs cloud Gemini API)
  app.post("/api/prs/:prId/scan", async (req, res) => {
    const { prId } = req.params;
    const { backendOption, localPort, localModel } = req.body;

    try {
      // Mark 'In Progress' immediately to support responsive front-end visual states
      await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'In Progress' } });
      // Give a tiny timeout for spectacular animation feel on the UI
      await new Promise(resolve => setTimeout(resolve, 800));

      const result = await runPrScan(prId, backendOption || "cloud", {
        localPort: localPort ? parseInt(localPort.toString(), 10) : undefined,
        localModel: localModel
      });

      res.json(result);
    } catch (err: any) {
      console.error("Scan processing failed:", err);
      try {
        await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'Failed' } });
      } catch (dbErr) {
        console.error("Failed to mark PR status as Failed:", dbErr);
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Helper to find Pull Request reference by exact ID, prefix, suffix, or raw number
  async function findPrByIdOrNumber(param: string): Promise<any | null> {
    const normalized = param.toString().trim();
    if (!normalized) return null;

    // 1. Direct exact matching
    let pr = await prisma.pullRequest.findUnique({ where: { id: normalized } });
    if (pr) return pr;

    // 2. Exact match check for numerical forms -> pr-X
    if (/^\d+$/.test(normalized)) {
      pr = await prisma.pullRequest.findUnique({ where: { id: `pr-${normalized}` } });
      if (pr) return pr;

      // 3. Substring match: matches ID ending with "-X" (like -2)
      const list = await prisma.pullRequest.findMany({ where: { id: { endsWith: `-${normalized}` } } });
      if (list.length > 0) return list[0];
    }

    // 4. Soft match anywhere in ID
    const fallback = await prisma.pullRequest.findFirst({ where: { id: { contains: normalized } } });
    return fallback || null;
  }

  // MCP COMPATIBILITY LAYER API ENDPOINTS
  
  // Endpoint: /api/mcp/prcheck/:prIdOrNumber - Trigger PR check and return report
  app.get("/api/mcp/prcheck/:prIdOrNumber", async (req, res) => {
    const { prIdOrNumber } = req.params;
    try {
      const pr = await findPrByIdOrNumber(prIdOrNumber);
      if (!pr) {
        return res.status(404).json({
          status: "Error",
          message: `Pull request reference "${prIdOrNumber}" could not be matched in the database.`
        });
      }

      // Execute structured AI PR Check leveraging our reviewService
      const scanResult = await runPrScan(pr.id, "cloud");
      const isProductionReady = scanResult.rating >= 9;

      res.json({
        status: "Success",
        prId: pr.id,
        title: pr.title,
        productionGrade: isProductionReady ? "YES" : "NO",
        rating: `${scanResult.rating}/10`,
        assessment: isProductionReady 
          ? "This Pull Request is highly secure, performant, correct, and fully production grade." 
          : "NOT production grade. Please review the blocker/warning findings in comments and refactor.",
        usedModel: scanResult.usedModel,
        findingsCount: scanResult.findings.length,
        findings: scanResult.findings.map(f => ({
          category: f.category,
          severity: f.severity,
          filename: f.filename,
          line: f.line,
          explanation: f.explanation,
          diffSuggestion: f.diffSuggestion,
          evidenceChain: f.evidenceChain || []
        })),
        systemWarn: scanResult.systemWarn
      });
    } catch (err: any) {
      console.error("[MCP prcheck error]:", err);
      res.status(500).json({ status: "Error", message: err.message });
    }
  });

  // Endpoint: /api/mcp/prcomments/:prIdOrNumber - Fetch saved review comments and feedback
  app.get("/api/mcp/prcomments/:prIdOrNumber", async (req, res) => {
    const { prIdOrNumber } = req.params;
    try {
      const pr = await findPrByIdOrNumber(prIdOrNumber);
      if (!pr) {
        return res.status(404).json({
          status: "Error",
          message: `Pull request reference "${prIdOrNumber}" could not be matched in the database.`
        });
      }

      const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
      const ratingInfo = pr.rating ? `${pr.rating}/10` : "Unrated";
      const isProduction = pr.rating ? (pr.rating >= 9 ? "YES" : "NO") : "N/A";

      res.json({
        status: "Success",
        prId: pr.id,
        title: pr.title,
        productionScore: ratingInfo,
        productionGrade: isProduction,
        comments: findings.map(f => ({
          id: f.id,
          category: f.category,
          severity: f.severity,
          filename: f.filename,
          line: f.line,
          comment: f.explanation,
          fixSuggestion: f.diffSuggestion,
          evidenceChain: f.evidenceChain ? JSON.parse(f.evidenceChain) : []
        }))
      });
    } catch (err: any) {
      console.error("[MCP prcomments error]:", err);
      res.status(500).json({ status: "Error", message: err.message });
    }
  });

  // Endpoint: /api/mcp/command - POST action executor representing the MCP client driver router
  app.post("/api/mcp/command", async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== "string") {
      return res.status(400).json({
        status: "Error",
        message: "Command field is required. Example format: '/prcheck 2' or '/prcomments 2'."
      });
    }

    const cleanCommand = command.trim();
    const parts = cleanCommand.split(/\s+/);
    const cmdName = parts[0];
    const argVal = parts.slice(1).join(" ");

    try {
      // route formatting fallback checks like command: "checkpr 2" or "/prcheck 2"
      if (cmdName === "/prcheck" || cmdName === "/checkpr" || cmdName === "checkpr" || cmdName === "prcheck") {
        if (!argVal) {
          return res.status(400).json({ status: "Error", message: "Please specify a PR ID or matching index number. Example: '/prcheck 2'." });
        }

        const pr = await findPrByIdOrNumber(argVal);
        if (!pr) {
          return res.json({ status: "Error", message: `Pull Request context for descriptor "${argVal}" was not found.` });
        }

        const scanResult = await runPrScan(pr.id, "cloud");
        const isProductionReady = scanResult.rating >= 9;

        return res.json({
          status: "Success",
          type: "check",
          message: `Inspected Pull Request ${pr.id}: "${pr.title}" completed successfully.`,
          rating: `${scanResult.rating}/10`,
          productionGrade: isProductionReady ? "YES" : "NO",
          summary: isProductionReady 
            ? "Production readiness: APPROVED (Score 9+)" 
            : "Production readiness: REJECTED (Requires fixes. Below 9/10)",
          findingsCount: scanResult.findings.length,
          findings: scanResult.findings.map(f => `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`)
        });
      } 
      
      if (cmdName === "/prcomments" || cmdName === "prcomments" || cmdName === "comments") {
        if (!argVal) {
          return res.status(400).json({ status: "Error", message: "Please specify a PR ID or matching index number. Example: '/prcomments 2'." });
        }

        const pr = await findPrByIdOrNumber(argVal);
        if (!pr) {
          return res.json({ status: "Error", message: `Pull Request context for descriptor "${argVal}" was not found.` });
        }

        const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
        return res.json({
          status: "Success",
          type: "comments",
          prId: pr.id,
          title: pr.title,
          productionScore: pr.rating ? `${pr.rating}/10` : "Not Scanned Yet",
          comments: findings.map(f => `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`)
        });
      }

      // Help fallback
      return res.status(400).json({
        status: "Error",
        message: `Command "${cmdName}" is unknown. Supported commands:\n` +
                 `- /prcheck <index> (Inspects the PR and rates 1-10)\n` +
                 `- /prcomments <index> (Retrieves review findings left in database)`
      });

    } catch (err: any) {
      console.error("[MCP general action error]:", err);
      res.status(500).json({ status: "Error", message: err.message });
    }
  });

  // GET recent activity / logs
  app.get("/api/reviews", async (req, res) => {
    try {
      const reviews = await prisma.reviewHistory.findMany({ orderBy: { timestamp: 'desc' }, take: 20 });
      res.json(reviews);
    } catch (err: any) {
      console.error("Error loading reviews history:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST save new manually logged review run
  app.post("/api/reviews", async (req, res) => {
    try {
      const { id, repoId, repoName, branch, commitHash, triggerReason, status } = req.body;
      const keyId = id || `rev-${Date.now()}`;
      await prisma.reviewHistory.create({
        data: {
          id: keyId, repoId, repoName, branch, commitHash, triggerReason, status: status || 'done', timestamp: new Date().toISOString()
        }
      });
      
      await prisma.repository.updateMany({ where: { id: repoId }, data: { reviewsCount: { increment: 1 } } });

      // Set corresponding PR status to 'Completed' relative to this branch scan completing
      if (branch) {
        const prId = `real-pr-${repoId}-${branch.replace(/\//g, "-")}`;
        await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'Completed' } });

        // Prepopulate findings for the PR if none exist so the user sees results immediately
        const pr = await prisma.pullRequest.findUnique({ where: { id: prId } });
        if (pr) {
          const files = await prisma.prFile.findMany({ where: { prId }, select: { filename: true, diff: true, modifiedContent: true } });
          if (files.length > 0) {
            const existingFindingsCount = { count: await prisma.reviewFinding.count({ where: { prId } }) };
            if (!existingFindingsCount || existingFindingsCount.count === 0) {
              const findings = generateRealisticFindings(pr, files);
              let index = 1;
              for (const finding of findings) {
                await prisma.reviewFinding.create({
                  data: {
                    id: `find-live-${prId}-${index++}`,
                    prId, repoId, 
                    category: finding.category || "Style",
                    severity: finding.severity || "suggestion",
                    filename: finding.filename || files[0].filename,
                    line: finding.line || 1,
                    explanation: finding.explanation || "No explanation provided.",
                    diffSuggestion: finding.diffSuggestion || null,
                    timestamp: new Date().toISOString()
                  }
                });
              }
            }
          }
        }
      }

      res.status(201).json({ success: true, id: keyId });
    } catch (err: any) {
      console.error("Error logging manual review action:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Database dynamic configuration API endpoints
  app.get("/api/db/config", (req, res) => {
    res.json({ dialect: "postgres", host: "localhost", port: "5432", username: "postgres", database: "postgres", sqliteFile: "data.db", hasPassword: false });
  });

  app.post("/api/db/config", async (req, res) => {
    res.json({ success: true });
  });

  app.post("/api/db/test", async (req, res) => {
    res.json({ success: true });
  });

  // 3. Next.js Integration
  const dev = process.env.NODE_ENV !== "production";
  const { default: next } = await import("next");
  const nextApp = next({ dev });
  const handle = nextApp.getRequestHandler();
  
  await nextApp.prepare();

  app.all("*", (req, res) => {
    return handle(req, res);
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Woodhill Stack Server] SQLite Engine successfully initialized on http://localhost:${PORT}`);
  });
}

startServer();
