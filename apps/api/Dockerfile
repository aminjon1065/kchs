# API/worker kchs и CLI `kchs`. Сборка из корня монорепо: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Клиент PostgreSQL 17 из репозитория PGDG: `pg_dump` резервных копий обязан
# быть не старше сервера (15-admin-operations.md §5), а в Debian bookworm 15-й
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gnupg; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-17; \
    apt-get purge -y gnupg; apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# ── Зависимости ──────────────────────────────────────────────────────────────
FROM base AS manifests
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/fields/package.json packages/fields/
COPY packages/i18n/package.json packages/i18n/
COPY packages/map-style/package.json packages/map-style/
COPY packages/process/package.json packages/process/
COPY apps/api/package.json apps/api/

FROM manifests AS deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @kchs/api...

# Только зависимости времени выполнения, с нуля: пакеты монорепо уже в бандле
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @kchs/api...

# ── Сборка ───────────────────────────────────────────────────────────────────
# esbuild собирает api/worker и CLI вместе с пакетами монорепо (они экспортируют
# исходники TypeScript) и алиасом ~/ — см. apps/api/scripts/build.mjs
FROM deps AS build
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @kchs/api build

# ── Итоговый образ ───────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /repo

COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json

# `kchs init | migrate | seed` внутри контейнера: docker compose exec api kchs init
RUN printf '#!/bin/sh\nexec node /repo/apps/api/dist/kchs.js "$@"\n' > /usr/local/bin/kchs \
 && chmod 755 /usr/local/bin/kchs

ENV NODE_ENV=production PORT=3000 NODE_OPTIONS=--enable-source-maps
WORKDIR /repo/apps/api
# Код остаётся за root и процессу доступен только на чтение (без chown -R, который
# копировал node_modules в новый слой); писать процессу нужно лишь в /tmp
RUN useradd --system --uid 10001 --create-home kchs
USER kchs

EXPOSE 3000
# Проверка api; у контейнера worker своя — по файлу-признаку жизни (docker-compose.yml)
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:3000/health || exit 1

# Предзагрузка трасс OpenTelemetry: без OTEL_EXPORTER_OTLP_ENDPOINT ничего не делает
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]
