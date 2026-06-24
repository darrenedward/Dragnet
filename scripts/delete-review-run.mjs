/**
 * One-shot script: delete a cached ReviewRun + all its findings.
 *
 * Use case: the verifier was buggy when a scan ran, the bad findings got
 * cached under a ReviewRun, and the freshness cache keeps serving them
 * on every subsequent scan (because the diff/config haven't changed).
 * Deleting the run forces the next scan to re-run the LLM + verifier.
 *
 * Usage:
 *   set -a && source .env.local && set +a && \
 *     node scripts/delete-review-run.mjs <runId>
 *
 * Cascades: ReviewFinding.reviewRunId has onDelete: Cascade in the schema,
 * so deleting the run would cascade-delete findings anyway. We delete the
 * findings explicitly first so the count is logged — useful when you're
 * debugging a noisy scan and want to confirm how many findings got purged.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const runId = process.argv[2];
if (!runId) {
  console.error("[delete-run] usage: node scripts/delete-review-run.mjs <runId>");
  process.exit(1);
}

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("[delete-run] DATABASE_URL not set");
  process.exit(1);
}

const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs
  .replace(/&?sslmode=[^&]*/gi, "")
  .replace(/\?&/, "?")
  .replace(/\?$/, "")
  .replace(/&&/g, "&");
const pool = new Pool({
  connectionString: stripped,
  ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.reviewRun.findUnique({
    where: { id: runId },
    select: { id: true, prId: true, status: true, completedAt: true },
  });
  if (!existing) {
    console.log(`[delete-run] no ReviewRun with id=${runId} — nothing to delete.`);
    return;
  }

  const findings = await prisma.reviewFinding.deleteMany({
    where: { reviewRunId: runId },
  });
  console.log(`[delete-run] deleted ${findings.count} finding(s) from run ${runId}`);

  await prisma.reviewRun.delete({ where: { id: runId } });
  console.log(
    `[delete-run] deleted run ${runId} (prId=${existing.prId}, status=${existing.status}). ` +
      `Next scan for this PR will run fresh.`,
  );
}

main()
  .catch((e) => {
    console.error("[delete-run] failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
