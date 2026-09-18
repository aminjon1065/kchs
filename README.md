# kchs

**kchs** — единая корпоративная рабочая платформа: данные и аналитика, GIS-карты,
документооборот, файлы, задачи и поручения, коммуникации, встречи, календарь,
знания и автоматизация — в одном рабочем пространстве.

Ядро продукта — аналитика и работа с данными (включая пространственные).
Остальные модули построены поверх общего платформенного ядра и связаны между
собой через единый реестр объектов.

## Состояние

Идёт **фаза 0 — ядро платформы**. Что уже работает, что проверено и какой шаг
следующий — в [`docs/progress.md`](docs/progress.md).

## Быстрый старт

Нужны Docker, Node 22 и pnpm 10+.

```bash
bash infra/scripts/generate-secrets.sh   # .env со случайными секретами
pnpm install
docker compose up -d --wait              # postgres+postgis, redis, minio, meilisearch, mailpit
pnpm db:migrate                          # схема ядра
pnpm db:seed                             # демо-организация: 61 человек, 22 подразделения
pnpm dev                                 # api (:3000) и web (:5173)
```

Открыть <http://localhost:5173> и войти как `admin` с паролем из
`SEED_ADMIN_PASSWORD` (по умолчанию `Kchs!Start-2026-7q`). Сотрудники —
`user001…user060`, пароль `SEED_USER_PASSWORD`. Письма приложения в разработке
уходят в mailpit: <http://localhost:8025>.

Полное развёртывание одним стеком (образы api, worker, engine, web за Caddy):

```bash
docker compose --profile app up -d --build
```

## Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | api + web в режиме разработки |
| `pnpm lint` / `pnpm typecheck` | Biome и `tsc --noEmit` во всех пакетах |
| `pnpm test` | unit-тесты (контракты, поля, криптография) |
| `pnpm test:integration` | интеграционные тесты API (база `kchs_test`) |
| `pnpm e2e` | сквозные сценарии Playwright |
| `pnpm deps:check` | границы модулей (dependency-cruiser) |
| `pnpm i18n:check` | полнота словарей ru/tg/en |
| `pnpm db:migrate` / `db:seed` / `db:reset` | схема и демонстрационные данные |
| `pnpm --filter @kchs/ui tokens` | перегенерация CSS-переменных из `tokens.json` |
| `pnpm --filter @kchs/ui contrast` | проверка контраста WCAG 2.2 AA |
| `bash infra/scripts/smoke-api.sh` | дымовой прогон HTTP API (41 проверка) |

## Структура

```
apps/api      Fastify: HTTP, WebSocket, ядро платформы и модули (роли api|worker|all)
apps/web      React SPA: оболочка рабочего пространства и экраны
apps/engine   Python: тяжёлые вычисления, геоформаты, рендеринг, OCR, ИИ
packages/     contracts (zod), fields, ui (дизайн-система), i18n, config
infra/        compose, скрипты, наблюдаемость, runbooks
seeds/        демонстрационные данные
docs/         проектная документация — источник истины
```

## Документация

| Раздел | Содержание |
|---|---|
| [`docs/00-start-here.md`](docs/00-start-here.md) | Точка входа и порядок чтения |
| [`docs/progress.md`](docs/progress.md) | Журнал реализации: сделано, проверено, дальше |
| `docs/01-product/` | Видение, пользователи, сценарии, функциональный состав |
| `docs/02-architecture/` | Архитектура, ядро, доступ, модель данных, модули, стек |
| `docs/03-ui/` | Концепция интерфейса, дизайн-система, экраны, паттерны |
| `docs/04-delivery/` | Структура проекта, дорожная карта, бэклог, проверка, риски |
| `docs/contracts/` | Сквозные контракты (QuerySpec, ChartSpec, LayerStyle и др.) |
| `docs/adr/` | Записи архитектурных решений |
