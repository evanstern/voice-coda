# ---- Base ----
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps

# Copy workspace config and all package.json files for install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --frozen-lockfile

# ---- Build ----
FROM deps AS build

COPY . .

# Build the web app and all its workspace dependencies
RUN pnpm run build --filter=@voice-coda/web...

# ---- Runner ----
FROM node:22-slim AS runner

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 appuser

ENV NODE_ENV=production
WORKDIR /app

# Copy the built web app (server + client bundles)
COPY --from=build /app/apps/web/build/ ./build/

# Copy production node_modules needed at runtime
# React Router SSR needs its runtime dependencies
COPY --from=deps /app/node_modules/ ./node_modules/
COPY --from=deps /app/apps/web/node_modules/ ./apps/web/node_modules/

# Copy package.json for module resolution
COPY --from=build /app/apps/web/package.json ./

EXPOSE 3000

USER appuser

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "build/server/index.js"]
