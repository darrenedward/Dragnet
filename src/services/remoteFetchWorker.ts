import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { prisma } from "../lib/prisma";
import { decryptSecret, hasMasterKey } from "../lib/crypto";
import { ContainerOrchestrator } from "../lib/containerOrchestrator";
import { buildSshEnv } from "../lib/gitService";
import { getInstallationToken } from "../lib/githubApp";
import { IndexingService } from "./indexingService";
import { shellEscape } from "../lib/shellEscape";
import {
  VOLUME_WORKSPACE_PATH,
  usableHostLocalPath,
} from "../lib/repoClonePath";

const activeFetches = new Set<string>();
const GIT_IMAGE = process.env.DRAGNET_GIT_IMAGE ?? "alpine/git";

function volumeName(repoId: string): string {
  return `dragnet-repo-${repoId}`;
}

function interpolatePat(cloneUrl: string, pat?: string): string {
  if (!pat) return cloneUrl;
  try {
    const u = new URL(cloneUrl);
    if (u.protocol !== "https:") {
      console.warn(`[remoteFetchWorker] PAT only works with HTTPS URLs, got protocol "${u.protocol}" — PAT ignored`);
      return cloneUrl;
    }
    u.username = "x-access-token";
    u.password = pat;
    return u.toString();
  } catch {
    console.warn(`[remoteFetchWorker] Failed to parse cloneUrl for PAT injection — "${cloneUrl}" is not a valid URL; PAT ignored`);
    return cloneUrl;
  }
}

export function isFetching(repoId: string): boolean {
  return activeFetches.has(repoId);
}

async function markCloneFailed(repoId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const truncated = message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
  console.error(`[remoteFetchWorker] clone-failed for ${repoId}:`, truncated);
  try {
    await prisma.repository.update({
      where: { id: repoId },
      data: {
        status: "error",
        lastFetchError: truncated,
      },
    });
  } catch (updateErr) {
    console.error(`[remoteFetchWorker] failed to persist clone error for ${repoId}:`, updateErr);
  }
}

export async function enqueue(repoId: string): Promise<string | null> {
  if (activeFetches.has(repoId)) return null;
  activeFetches.add(repoId);

  try {
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) throw new Error(`Repository not found: ${repoId}`);
    if (repo.provider === "local" || !repo.cloneUrl) {
      throw new Error(`Repository ${repoId} is not a remote repo`);
    }

    let deployKey: string | undefined;
    let pat: string | undefined;
    let installationToken: string | undefined;

    if (repo.deployKeyCipher && repo.deployKeyIv && repo.deployKeyTag) {
      if (!hasMasterKey()) throw new Error("DRAGNET_MASTER_KEY is not set");
      deployKey = decryptSecret(repo.deployKeyCipher, repo.deployKeyIv, repo.deployKeyTag);
    }

    if (repo.patCipher && repo.patIv && repo.patTag) {
      if (!hasMasterKey()) throw new Error("DRAGNET_MASTER_KEY is not set");
      pat = decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
    }

    // If neither deployKey nor PAT is configured, try installation token
    if (!deployKey && !pat && repo.installationId) {
      try {
        installationToken = await getInstallationToken(repo.installationId);
        console.log(`[remoteFetchWorker] using installation token for repo ${repoId}`);
      } catch (err: any) {
        console.warn(`[remoteFetchWorker] installation token fetch failed for ${repoId}:`, err.message);
      }
    }

    const effectivePat = installationToken || pat;
    // Stale rows may point localPath at /app/repos/<id> from a prior host layout
    // that no longer exists after redeploy. Fall back to Docker volume mode.
    const hostLocalPath = usableHostLocalPath(repo.localPath);
    const isContainerMode = hostLocalPath == null;

    let localPath: string;

    if (isContainerMode) {
      const orchestrator = ContainerOrchestrator.getInstance();
      const volName = volumeName(repoId);

      await orchestrator.createVolume(volName);

      const escapedUrl = shellEscape(interpolatePat(repo.cloneUrl, effectivePat));

      // Always update the remote URL on every fetch so credential changes
      // (PAT rotation, deploy key replacement) take effect even when the
      // volume's .git/config still has the old URL.
      const baseBranch = repo.baseBranch || "main";
      const syncScript = [
        "set -e",
        `cd /workspace && (git init 2>/dev/null; git remote add origin '${escapedUrl}' 2>/dev/null || git remote set-url origin '${escapedUrl}')`,
        "cd /workspace && git fetch origin --prune '+refs/heads/*:refs/heads/*'",
        `cd /workspace && git checkout --force '${shellEscape(baseBranch)}' 2>/dev/null || git checkout --force master 2>/dev/null || echo "no checkout target — repo may be empty"`,
      ].join(" && ");

      const extraEnv: Record<string, string> = {};
      let result: Awaited<ReturnType<typeof orchestrator.runRunner>>;

      // Keep SSH temp files alive during the container run
      {
        using ssh = deployKey
          ? buildSshEnv(deployKey, `clone-${repoId}`)
          : { env: {} as Record<string, string>, [Symbol.dispose]() {} };
        Object.assign(extraEnv, ssh.env);

        result = await orchestrator.runRunner({
          volumeName: volName,
          image: GIT_IMAGE,
          commands: [syncScript],
          networkMode: "bridge",
          env: extraEnv,
          timeoutMs: 300_000,
        });
      }

      if (result.exitCode !== 0 && !result.timedOut) {
        throw new Error(
          `Git sync failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        );
      }
      if (result.timedOut) {
        throw new Error(`Git sync timed out for repo ${repoId}`);
      }

      localPath = VOLUME_WORKSPACE_PATH;

      // App-owned marker — users never set this path.
      if (repo.localPath !== VOLUME_WORKSPACE_PATH) {
        await prisma.repository.update({
          where: { id: repoId },
          data: { localPath: VOLUME_WORKSPACE_PATH },
        });
      }

      // Copy volume to a host temp dir so the code-graph indexer can walk it
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), `dragnet-idx-${repoId}-`));
      try {
        await orchestrator.copyVolumeToHost(volName, tmpDir, GIT_IMAGE);
        await IndexingService.indexFolder(repoId, tmpDir);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      // Legacy host-path mode — inline git fetch (no gitRemote dependency)
      using ssh = deployKey
        ? buildSshEnv(deployKey, `fetch-${repoId}`)
        : { env: {}, [Symbol.dispose]() {} };

      execFileSync("git", ["-C", hostLocalPath!, "fetch", "origin", "--prune", "+refs/heads/*:refs/heads/*"], {
        env: { ...process.env, ...ssh.env },
        stdio: "pipe",
        timeout: 120_000,
      });

      localPath = hostLocalPath!;

      await IndexingService.indexFolder(repoId, localPath);
    }

    await prisma.repository.update({
      where: { id: repoId },
      data: {
        lastFetchAt: new Date(),
        lastFetchError: null,
        status: "idle",
      },
    });

    return localPath;
  } catch (err) {
    await markCloneFailed(repoId, err);
    throw err;
  } finally {
    activeFetches.delete(repoId);
  }
}
