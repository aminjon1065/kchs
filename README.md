# kchs

**kchs** — единая корпоративная рабочая платформа: данные и аналитика, GIS-карты,
документооборот, файлы, задачи и поручения, коммуникации, встречи, календарь,
знания и автоматизация — в одном рабочем пространстве.

Ядро продукта — аналитика и работа с данными (включая пространственные).
Остальные модули построены поверх общего платформенного ядра и связаны между
собой через единый реестр объектов.

## Состояние

Фазы 0–5 закрыты приёмкой и слиты в `main` (теги v0.1.0…v0.6.0). Идёт
предметный пакет «Чрезвычайные ситуации» для демонстрации Комитету. Что уже
работает, что проверено и какой шаг следующий — в
[`docs/progress.md`](docs/progress.md); руководства пользователя и
администратора — в [`docs/06-guides/`](docs/06-guides/00-index.md).

## Быстрый старт

### Разработка

Нужны Docker, Node 22 и pnpm 10+. Инфраструктура работает в Docker, api и web — на хосте.

```bash
bash infra/scripts/generate-secrets.sh   # .env со случайными секретами (режим dev)
pnpm install
docker compose up -d --wait              # postgres+postgis, redis, minio, meilisearch, mailpit
pnpm db:migrate                          # схема ядра
pnpm db:seed                             # демо-организация: 61 человек, 22 подразделения
pnpm dev                                 # api с worker (:3000) и web (:5173)
```

Открыть <http://localhost:5173> и войти как `admin` с паролем из
`SEED_ADMIN_PASSWORD` (по умолчанию `Kchs!Start-2026-7q`). Сотрудники —
`user001…user060`, пароль `SEED_USER_PASSWORD`. Письма приложения в разработке
уходят в mailpit: <http://localhost:8025>.

Движок (превью файлов, геоформаты, OCR) — контейнер, который вызывает api на хосте:
`docker compose up -d --wait engine`. Первая сборка его образа долгая.

Совместное редактирование офисных файлов (ADR-0112) — сервер документов ONLYOFFICE
отдельным профилем: `docker compose --profile office up -d --wait onlyoffice`. Пока
его нет, кнопки «Открыть в редакторе» не видно, а файлы скачиваются обычным путём.

### Установка (всё в контейнерах)

Нужен Docker 27+ с Compose v2; Node на сервере не нужен.

```bash
bash infra/scripts/generate-secrets.sh --mode app    # .env: секреты и адреса полного развёртывания
docker compose --profile app up -d --build --wait    # данные, api, worker, engine, web (Caddy)
docker compose exec api kchs init --admin-email admin@example.org
```

`kchs init` применяет миграции, создаёт системные роли и поисковый индекс, заносит
праздники РТ с постоянной датой на текущий и следующий год и первого администратора
(`--admin-login`, по умолчанию `admin`; можно задать `KCHS_ADMIN_LOGIN` и
`KCHS_ADMIN_EMAIL` в `.env`). Временный пароль печатается один раз: при первом входе на
<http://localhost:8080> система попросит задать свой. Повторный запуск безопасен —
администратор не пересоздаётся. Демо-данные по желанию: `docker compose exec api kchs seed`.

- Вход — только через web (Caddy со сборкой SPA): статика, `/api`, `/ws`, CSP. Порт —
  `WEB_PORT` (8080). Для домена с автоматическим HTTPS: `KCHS_DOMAIN=kchs.example.org`,
  `WEB_PORT=80`, `WEB_HTTPS_PORT=443`, `KCHS_BASE_URL=https://kchs.example.org`,
  `KCHS_API_URL=https://kchs.example.org/api`.
- Файлы браузер загружает и получает напрямую из MinIO по подписанным ссылкам:
  `S3_PUBLIC_ENDPOINT` и `KCHS_STORAGE_ORIGIN` — адрес хранилища, видимый браузеру
  (порт `S3_PORT`, 9000). Если web работает по HTTPS, хранилище тоже должно быть по HTTPS.
- Postgres, Redis, Meilisearch, консоль MinIO и mailpit публикуются только на самом
  сервере (`KCHS_BIND=127.0.0.1`).
- Обновление: `docker compose --profile app up -d --build --wait`; миграции применяет api
  при старте, `kchs init` повторять не нужно.

Вся цепочка на чистых томах в отдельном проекте compose (стенд разработки не
затрагивается): `bash infra/scripts/verify-stack.sh` — секреты, сборка образов, `up`,
`kchs init`, демо-данные, дымовой прогон API через web и браузер (вход, «Мой день»,
загрузка файла, превью от движка) с временем каждого шага. То же в CI — workflow
«Установка в контейнерах» (ночью, на PR с меткой `stack`, вручную).

## Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | api + web в режиме разработки |
| `pnpm lint` / `pnpm typecheck` | Biome и `tsc --noEmit` во всех пакетах |
| `pnpm test` | unit-тесты (контракты, поля, криптография) |
| `pnpm test:integration` | интеграционные тесты API (база `kchs_test`; отдельная база для параллельного прогона — `bash apps/api/scripts/test-slot.sh N` и `KCHS_TEST_SLOT=N`) |
| `pnpm e2e` | сквозные сценарии Playwright |
| `pnpm deps:check` | границы модулей (dependency-cruiser) |
| `pnpm i18n:check` / `pnpm i18n:literals` | полнота словарей ru/tg/en; тексты интерфейса только из словарей |
| `pnpm db:migrate` / `db:seed` / `db:reset` | схема и демонстрационные данные |
| `pnpm kchs init` / `migrate` / `seed` | команды установки на хосте; в контейнере — `docker compose exec api kchs …` |
| `bash infra/scripts/verify-stack.sh` | установка с нуля в отдельном проекте compose и проверки (`SKIP_BUILD=1` — без сборки, `KEEP=1` — оставить стенд) |
| `pnpm --filter @kchs/ui tokens` | перегенерация CSS-переменных из `tokens.json` |
| `pnpm --filter @kchs/ui contrast` | проверка контраста WCAG 2.2 AA |
| `pnpm storybook` | Storybook дизайн-системы на <http://localhost:6006> |
| `pnpm --filter @kchs/ui test:visual` | снимки историй в двух темах и axe (Docker, образ Playwright); `test:visual:update` — обновить снимки |
| `bash infra/scripts/smoke-api.sh` | дымовой прогон HTTP API (41 проверка); адрес и пароли — `KCHS_SMOKE_BASE`, `KCHS_SMOKE_ADMIN_PASSWORD`, `KCHS_SMOKE_USER_PASSWORD` |

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
| [`docs/06-guides/`](docs/06-guides/00-index.md) | Руководства пользователя и администратора (по действительности) |
