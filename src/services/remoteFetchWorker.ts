import { prisma } from "../lib/prisma";
import { decryptSecret, hasMasterKey } from "../lib/crypto";
import { cloneRepo, fetchRepo } from "../lib/gitRemote";
import { getInstallationToken } from "../lib/githubApp";
import { IndexingService } from "./indexingService";

const activeFetches = new Set<string>();

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

    let localPath = repo.localPath;
    if (!localPath) {
      localPath = cloneRepo({ repoId, cloneUrl: repo.cloneUrl, deployKey, pat, installationToken });
      await prisma.repository.update({
        where: { id: repoId },
        data: { localPath },
      });
    } else {
      fetchRepo({ localPath, cloneUrl: repo.cloneUrl, deployKey, pat, installationToken });
    }

    await IndexingService.indexFolder(repoId, localPath);

    await prisma.repository.update({
      where: { id: repoId },
      data: { lastFetchAt: new Date() },
    });

    return localPath;
  } finally {
    activeFetches.delete(repoId);
  }
}
