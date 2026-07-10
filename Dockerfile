# ─── Builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests + scripts + prisma schema first for layer caching.
# scripts/ must be present because postinstall runs scripts/copy-grammars.mjs.
# prisma/ must be present before `prisma generate` runs.
COPY package*.json ./
COPY scripts ./scripts
COPY prisma ./prisma

# Install deps (postinstall copies tree-sitter WASM into public/grammars/).
RUN npm ci

# Generate Prisma client — postinstall doesn't do this automatically.
RUN npx prisma generate

# Copy the rest of the source and build.
COPY . .
RUN npm run build

# ─── Runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Runtime OS deps:
#   git       — Dragnet clones repos into REPOS_DIR
#   curl      — healthcheck
#   openssl   — Prisma's pg adapter needs it for SSL to Supabase
#   docker-cli — orchestrator spawns alpine/git + runner images via the
#                host Docker daemon (mounted socket, read-only).
RUN apk add --no-cache git curl openssl docker-cli

# Copy build output + runtime assets from builder. Source .ts files are
# already bundled into .next/server/ — they don't need to exist here.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/next.config.ts ./next.config.ts

ENV NODE_ENV=production
ENV PORT=3300
ENV HOSTNAME=0.0.0.0

EXPOSE 3300

# Documented mount points — see docker-compose.yml for the bind mounts.
VOLUME ["/app/.dragnet", "/app/repos", "/var/lib/dragnet/scans"]

CMD ["npm", "run", "start"]
