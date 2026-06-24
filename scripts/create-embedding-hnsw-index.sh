#!/usr/bin/env bash
# Create the HNSW index on symbols.embedding.
#
# Prisma can't model pgvector index types — raw SQL is the supported
# path. Without this index, semanticSearch runs a brute-force cosine
# similarity scan over every embedding in the repo (O(n) per query).
# HNSW gives approximate nearest-neighbor in O(log n).
#
# The partial index (WHERE embedding IS NOT NULL) skips rows that have
# a summary but no embedding yet — common right after a model swap or
# when the dimension guard rejects a vector.
#
# Usage:
#   bash scripts/create-embedding-hnsw-index.sh
#
# Prerequisite: DATABASE_URL in .env.local must point at the transaction
# pooler. The session-mode URL is derived (same as db-push-direct.sh).
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
SESSION_URL="postgresql://postgres.${PROJECT_REF}:${PASSWORD}@${POOLER_HOST}:5432/postgres?mode=session"

# HNSW build parameters: defaults are fine for code-symbol workloads
# (max 100k embeddings per repo). For 1M+ symbols, tune m and
# ef_construction — see pgvector docs.
SQL='CREATE INDEX IF NOT EXISTS symbols_embedding_hnsw_idx
ON "symbols" USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;'

echo "[hnsw-index] session pooler: ${POOLER_HOST}:5432"
echo "[hnsw-index] creating HNSW index on symbols.embedding..."
echo ""

echo "$SQL" | DATABASE_URL="$SESSION_URL" npx prisma db execute --stdin

echo ""
echo "[hnsw-index] done. Verify with:"
echo "  SELECT indexname FROM pg_indexes WHERE tablename = 'symbols';"
