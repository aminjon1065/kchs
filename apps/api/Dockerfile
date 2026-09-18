# API/worker kchs. Сборка идёт из корня монорепо: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# ── Зависимости ──────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/fields/package.json packages/fields/
COPY packages/i18n/package.json packages/i18n/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @kchs/api...

# ── Сборка ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @kchs/api build

# ── Итоговый образ ───────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /repo

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json

ENV NODE_ENV=production PORT=3000
WORKDIR /repo/apps/api
RUN useradd --system --uid 10001 --create-home kchs && chown -R kchs:kchs /repo
USER kchs

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["node", "dist/main.js"]
