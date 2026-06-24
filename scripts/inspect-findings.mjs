/**
 * Inspect persisted findings for a PR — shows filename, line, category,
 * verification status, and the verifier's note for each. Read-only.
 *
 * Usage:
 *   set -a && source .env.local && set +a && \
 *     node scripts/inspect-findings.mjs <prId>
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const prId = process.argv[2];
if (!prId) {
  console.error("[inspect] usage: node scripts/inspect-findings.mjs <prId>");
  process.exit(1);
}

const cs = process.env.DATABASE_URL;
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new Pool({
  connectionString: stripped,
  ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const findings = await prisma.reviewFinding.findMany({
  where: { prId },
  select: {
    id: true,
    filename: true,
    line: true,
    category: true,
    severity: true,
    verificationStatus: true,
    verificationNote: true,
    explanation: true,
  },
  orderBy: { timestamp: "desc" },
});

console.log(`[inspect] ${findings.length} finding(s) for prId=${prId}\n`);
for (const f of findings) {
  console.log(`  ${f.severity.padEnd(10)} ${f.category.padEnd(15)} ${String(f.filename || "(no file)").padEnd(60)} L${String(f.line ?? "?").padEnd(5)}`);
  console.log(`    status: ${f.verificationStatus ?? "(null)"}`);
  console.log(`    note:   ${f.verificationNote ?? "(null)"}`);
  console.log(`    expl:   ${(f.explanation || "(empty)").slice(0, 100)}`);
  console.log("");
}

await prisma.$disconnect();
