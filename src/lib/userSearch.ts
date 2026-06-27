import { prisma } from "@/src/lib/prisma";

export async function searchUsersByName(query: string) {
  // WHERE restricted to `name` only — matching on `email` enabled prefix
  // enumeration (e.g. `?q=al` revealed which users have emails starting
  // "al..."). Email lookup belongs on a separate, admin-gated endpoint.
  return prisma.user.findMany({
    where: {
      name: { contains: query, mode: "insensitive" },
    },
    select: { id: true, name: true },
    take: 50,
  });
}
