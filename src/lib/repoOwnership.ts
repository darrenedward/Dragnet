import { prisma } from "./prisma";

/**
 * Captures the owner of a freshly-created repository: writes
 * `Repository.ownerId` and mirrors the ownership as a `UserRepo`
 * admin row with `invitedById = ownerId` (self-invite).
 *
 * After this call, the owner is indistinguishable from any other
 * admin at the query layer — the sidebar / invite gate treats them
 * the same. This is the load-bearing piece of the unified access
 * model from #69.
 *
 * Idempotent on the `UserRepo` side via `upsert`. The repo update
 * overwrites `ownerId` blindly — that's the intent (creation-time
 * capture is the only legitimate writer here).
 */
export async function captureRepoOwnership(
  repoId: string,
  ownerId: string | null,
): Promise<void> {
  if (!ownerId) return;
  await prisma.repository.update({
    where: { id: repoId },
    data: { ownerId },
  });
  await prisma.userRepo.upsert({
    where: { userId_repoId: { userId: ownerId, repoId } },
    create: { userId: ownerId, repoId, role: "admin", invitedById: ownerId },
    update: {},
  });
}
