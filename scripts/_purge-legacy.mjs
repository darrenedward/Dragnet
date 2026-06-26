// One-shot: delete the legacy-* ReviewRun rows and their attached findings.
// These are procedural-fallback template data from before that code path
// was removed. Their existence pollutes the UI with fake 8/10 ratings and
// "findings" that don't reflect any real LLM review.
//
// Run once: set -a && source .env.local && set +a && node scripts/_purge-legacy.mjs

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

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

const legacyRuns = await prisma.reviewRun.findMany({
  where: { id: { startsWith: "legacy-" } },
  select: { id: true, prId: true, status: true, rating: true, triggerReason: true },
});
console.log(`Found ${legacyRuns.length} legacy-* runs to delete:`);
for (const r of legacyRuns) {
  console.log(`  - ${r.id}  pr=${r.prId}  rating=${r.rating}`);
}

if (legacyRuns.length === 0) {
  console.log("Nothing to delete. Exiting.");
  await pool.end();
  process.exit(0);
}

const legacyRunIds = legacyRuns.map(r => r.id);

// Find findings attached to these runs (should also be deleted — they're fake).
const legacyFindings = await prisma.reviewFinding.findMany({
  where: { reviewRunId: { in: legacyRunIds } },
  select: { id: true, source: true, severity: true },
});
console.log(`\nFindings attached to legacy runs: ${legacyFindings.length}`);
const bySource = legacyFindings.reduce((acc, f) => {
  const k = f.source ?? "(null)";
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
console.log(`  by source: ${JSON.stringify(bySource)}`);

// Delete findings first (no cascade configured), then runs.
console.log("\nDeleting...");
const delFindings = await prisma.reviewFinding.deleteMany({
  where: { reviewRunId: { in: legacyRunIds } },
});
console.log(`  findings deleted: ${delFindings.count}`);

const delRuns = await prisma.reviewRun.deleteMany({
  where: { id: { in: legacyRunIds } },
});
console.log(`  runs deleted: ${delRuns.count}`);

// Verify.
const remaining = await prisma.reviewRun.findMany({
  where: { id: { startsWith: "legacy-" } },
  select: { id: true },
});
console.log(`\nRemaining legacy-* runs: ${remaining.length}`);

const remainingFindings = await prisma.reviewFinding.findMany({
  where: { source: null },
  select: { id: true, reviewRunId: true },
});
console.log(`Remaining source:null findings: ${remainingFindings.length}`);

await pool.end();
console.log("\nDone.");
