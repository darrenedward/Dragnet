// One-shot: force getRealLocalPrs on every repo. Applies merged-detection
// + full-hash fixes to existing DB rows.
//
// Run with: npx tsx scripts/_refresh-all-prs.mts

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getRealLocalPrs } from "../src/lib/getRealLocalPrs.ts";

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new pg.Pool({
  connectionString: stripped,
  ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const repos = await prisma.repository.findMany({ select: { id: true, name: true, path: true }});
console.log(`Refreshing ${repos.length} repos...\n`);

for (const r of repos) {
  if (!r.path) { console.log(`  [skip] ${r.name}: no path`); continue; }
  try {
    const prs = await getRealLocalPrs(r);
    const merged = prs?.filter(p => p.status === "Merged").length ?? 0;
    console.log(`  [ok] ${r.name}: ${prs?.length ?? 0} PRs (${merged} marked Merged)`);
  } catch (e: any) {
    console.log(`  [err] ${r.name}: ${e.message}`);
  }
}

await pool.end();
console.log("\nDone.");
