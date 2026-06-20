import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown & {
  __prismaPool?: Pool;
  __prisma?: PrismaClient;
};

if (!globalForPrisma.__prismaPool) {
  const cs =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/postgres";
  const wantsStrictSsl = Boolean(
    cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i),
  );
  const stripped = cs
    .replace(/&?sslmode=[^&]*/gi, "")
    .replace(/\?&/, "?")
    .replace(/\?$/, "")
    .replace(/&&/g, "&");
  globalForPrisma.__prismaPool = new Pool({
    connectionString: stripped,
    ssl: wantsStrictSsl
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false },
  });
}

if (!globalForPrisma.__prisma) {
  const adapter = new PrismaPg(globalForPrisma.__prismaPool);
  globalForPrisma.__prisma = new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.__prisma;
export const pool = globalForPrisma.__prismaPool;
