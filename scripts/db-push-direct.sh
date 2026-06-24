#!/usr/bin/env bash
# Apply the ReviewRun schema migration to Supabase.
#
# Supabase's transaction pooler (port 6543) rejects DDL with
# "prepared statement s0 already exists" — this script uses the direct
# connection (port 5432) which is the supported path for migrations.
#
# Usage:
#   bash scripts/db-push-direct.sh
#
# Prerequisite: DATABASE_URL in .env.local must point at the pooler
# (aws-*-ap-*.pooler.supabase.com:6543). The direct host is derived from
# the project ref in the username.
set -euo pipefail

if [[ ! -f .env.local ]]; then
  echo "Error: .env.local not found." >&2
  exit 1
fi

set -a; source .env.local; set +a

if [[ ! "$DATABASE_URL" =~ postgresql://postgres\.([^:]+):([^@]+)@([^:]+):6543/ ]]; then
  echo "Error: DATABASE_URL doesn't match the expected Supabase pooler pattern." >&2
  echo "Expected: postgresql://postgres.<ref>:<pw>@<host>:6543/postgres?pgbouncer=true..." >&2
  exit 1
fi

PROJECT_REF="${BASH_REMATCH[1]}"
PASSWORD="${BASH_REMATCH[2]}"
POOLER_HOST="${BASH_REMATCH[3]}"
# Direct host is db.<ref>.supabase.co, port 5432
DIRECT_HOST="db.${PROJECT_REF}.supabase.co"
DIRECT_URL="postgresql://postgres.${PROJECT_REF}:${PASSWORD}@${DIRECT_HOST}:5432/postgres"

echo "[db-push-direct] pooler: ${POOLER_HOST}:6543"
echo "[db-push-direct] direct: ${DIRECT_HOST}:5432"
echo "[db-push-direct] running npx prisma db push..."
echo ""

# Use --url to override the pooler URL from prisma.config.ts with the direct URL.
npx prisma db push --url "$DIRECT_URL"

echo ""
echo "[db-push-direct] schema applied. Run synthesize-legacy-review-runs next:"
echo "  node scripts/synthesize-legacy-review-runs.mjs"
