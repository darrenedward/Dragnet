import { execFileSync } from "node:child_process";
import { prisma } from "../lib/prisma";
import { decryptSecret, hasMasterKey } from "../lib/crypto";
import { ContainerOrchestrator } from "../lib/containerOrchestrator";
import { buildSshEnv } from "../lib/gitService";
import { getInstallationToken } from "../lib/githubApp";
import { IndexingService } from "./indexingService";
import { shellEscape } from "../lib/shellEscape";

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
    const isContainerMode = !repo.localPath || repo.localPath === "/workspace";

    let localPath: string;

    if (isContainerMode) {
      const orchestrator = ContainerOrchestrator.getInstance();
      const volName = volumeName(repoId);

      await orchestrator.createVolume(volName);

      const escapedUrl = shellEscape(interpolatePat(repo.cloneUrl, effectivePat));

      const syncScript = [
        "set -e",
        `[ -d /workspace/.git ] || (git init /workspace && cd /workspace && git remote add origin '${escapedUrl}')`,
        "cd /workspace && git fetch origin --prune",
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

      localPath = "/workspace";

      if (!repo.localPath) {
        await prisma.repository.update({
          where: { id: repoId },
          data: { localPath },
        });
      }
    } else {
      // Legacy host-path mode — inline git fetch (no gitRemote dependency)
      const url = interpolatePat(repo.cloneUrl, effectivePat);
      using ssh = deployKey
        ? buildSshEnv(deployKey, `fetch-${repoId}`)
        : { env: undefined as Record<string, string> | undefined, [Symbol.dispose]() {} };

      execFileSync("git", ["-C", repo.localPath!, "fetch", "origin", "--prune"], {
        env: { ...process.env, ...ssh.env },
        stdio: "pipe",
        timeout: 120_000,
      });

      localPath = repo.localPath;

      await IndexingService.indexFolder(repoId, localPath);
    }

    await prisma.repository.update({
      where: { id: repoId },
      data: { lastFetchAt: new Date() },
    });

    return localPath;
  } finally {
    activeFetches.delete(repoId);
  }
}
