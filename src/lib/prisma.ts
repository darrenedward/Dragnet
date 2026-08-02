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
  // Local Postgres (dev container, system cluster, embedded) doesn't speak
  // TLS by default — handing pg an `ssl: {}` object makes it try STARTTLS
  // and fail with "server does not support SSL". Detect:
  //   1. explicit `sslmode=disable` in the URL, OR
  //   2. host is loopback / localhost / *.local
  // and pass `ssl: false` so pg opens a plain TCP connection.
  const wantsNoSsl =
    Boolean(cs.match(/sslmode\s*=\s*(disable|allow|prefer)/i)) ||
    Boolean(
      cs.match(
        /@(localhost|127\.[\d.]+|::1|\[::1\]|[a-z0-9.-]+\.local)(:\d+)?\//i,
      ),
    );
  const stripped = cs
    .replace(/&?sslmode=[^&]*/gi, "")
    .replace(/\?&/, "?")
    .replace(/\?$/, "")
    .replace(/&&/g, "&");
  // Small VPS + scan queue interactive txs: default pg pool (10) + Prisma
  // maxWait 2s is too tight when dashboard polls + worker claim race.
  const poolMax = Math.max(
    4,
    Math.min(30, Number.parseInt(process.env.DRAGNET_PG_POOL_MAX ?? "20", 10) || 20),
  );
  globalForPrisma.__prismaPool = new Pool({
    connectionString: stripped,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: wantsNoSsl
      ? false
      : wantsStrictSsl
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false },
  });
}

if (!globalForPrisma.__prisma) {
  const adapter = new PrismaPg(globalForPrisma.__prismaPool);
  globalForPrisma.__prisma = new PrismaClient({
    adapter,
    // claimNextScanJob uses interactive tx + advisory lock; default maxWait
    // 2s / timeout 5s surfaces as P2028 under load on 1–2GB hosts.
    transactionOptions: {
      maxWait: 15_000,
      timeout: 30_000,
    },
  });
}

export const prisma = globalForPrisma.__prisma;
export const pool = globalForPrisma.__prismaPool;
