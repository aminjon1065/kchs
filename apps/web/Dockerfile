# Статика веб-клиента за Caddy. Сборка из корня монорепо.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/fields/package.json packages/fields/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @kchs/web...

FROM deps AS build
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @kchs/web exec vite build

FROM caddy:2-alpine AS runtime
COPY --from=build /repo/apps/web/dist /srv/web
# Конфигурация Caddy — в образе: в compose её перекрывает том с тем же файлом,
# в Kubernetes чарт (infra/helm/kchs) настраивает web только переменными
# окружения — KCHS_DOMAIN, KCHS_API_UPSTREAM, KCHS_STORAGE_ORIGIN (ADR-0118)
COPY infra/compose/caddy/Caddyfile /etc/caddy/Caddyfile
