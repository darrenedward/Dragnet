import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const cs = process.env.DATABASE_URL;
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new Pool({
  connectionString: stripped,
  ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const runs = await prisma.reviewRun.findMany({
  orderBy: { startedAt: "desc" },
  take: 10,
  select: {
    id: true, prId: true, status: true, startedAt: true, completedAt: true,
    rating: true, model: true, triggerReason: true, commitHash: true, forced: true,
  },
});
console.log(JSON.stringify(runs, null, 2));
const logs = await prisma.reviewLog.findMany({
  take: 5,
  orderBy: { createdAt: "desc" },
  select: { id: true, prId: true, reviewRunId: true, message: true, level: true, createdAt: true },
});
console.log("\n--- 5 most recent logs (checking reviewRunId population) ---");
console.log(JSON.stringify(logs, null, 2));
await pool.end();
