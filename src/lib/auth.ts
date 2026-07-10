import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins/organization";
import { prisma } from "./prisma";

/**
 * Single-tenant team model: every authenticated user belongs to exactly one
 * org. The first user to register becomes the org owner and any future
 * registrations are added as members via the Better Auth organization
 * plugin's invite flow.
 *
 * `databaseHooks.user.create.after` is invoked after Better Auth persists a
 * new User row. We don't have access to the auth client here (server-side
 * hook), so we write directly to the Organization + Member tables. Slug is
 * derived from the user's email local-part to keep the org stable across
 * sign-in; if it collides, we fall back to the user id.
 */
async function ensureFirstUserHasOrg(user: { id: string; email: string; name?: string | null }) {
  const existing = await prisma.organization.findFirst({ select: { id: true } });
  if (existing) return;
  const baseSlug = (user.email.split("@")[0] || user.id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 48) || `org-${user.id.slice(0, 8)}`;
  let slug = baseSlug;
  let attempt = 0;
  while (await prisma.organization.findUnique({ where: { slug } })) {
    attempt += 1;
    slug = `${baseSlug}-${attempt}`;
    if (attempt > 10) {
      slug = `org-${user.id.slice(0, 12)}`;
      break;
    }
  }
  const org = await prisma.organization.create({
    data: {
      name: user.name?.trim() || `${user.email}'s Workspace`,
      slug,
      ownerId: user.id,
    },
  });
  await prisma.member.create({
    data: { organizationId: org.id, userId: user.id, role: "owner" },
  });
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensureFirstUserHasOrg({ id: user.id, email: user.email, name: user.name });
        },
      },
    },
  },
  plugins: [organization()],
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3300",
});
