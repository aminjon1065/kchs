# Структура проекта и соглашения

Статус: **Решено** для структуры монорепо и границ; **Рекомендовано** для стилевых соглашений.

## Монорепо

```
kchs/
├── apps/
│   ├── web/                      # React SPA (Vite)
│   ├── api/                      # Fastify: HTTP, WS, collab; роли api|worker|all
│   └── engine/                   # Python: FastAPI (внутр.), BullMQ-воркеры
├── packages/
│   ├── contracts/                # zod-схемы API, событий, полей; генерация OpenAPI и типов
│   ├── fields/                   # система типов полей: валидация, форматирование, контролы-описания
│   ├── query/                    # QuerySpec, парсер выражений, компилятор SQL (диалекты)
│   ├── chart-spec/               # ChartSpec → ECharts option
│   ├── map-style/                # LayerStyle → MapLibre style + легенда
│   ├── process/                  # схема ProcessDefinition, валидатор, резолверы назначений (чистые)
│   ├── ui/                       # дизайн-система: токены, примитивы, компоненты, Storybook
│   ├── i18n/                     # словари ru/tg/en, ICU, форматтеры
│   ├── config/                   # общие tsconfig, biome, tailwind preset
│   └── testing/                  # фикстуры, фабрики, testcontainers-хелперы
├── infra/
│   ├── compose/                  # docker-compose.yml + профили, .env.example, init-скрипты
│   ├── helm/                     # чарт для S2
│   ├── observability/            # дашборды Grafana, правила алертов
│   ├── runbooks/                 # restore.md, upgrade.md, incident.md
│   └── scripts/                  # генерация секретов, PMTiles, бэкапы
├── seeds/                        # демо-организация, справочники, территории, предметный пакет
├── docs/                         # проектная документация (этот комплект) + progress.md + adr/
├── .github/workflows/            # CI
├── package.json  pnpm-workspace.yaml  turbo.json  biome.json  .dependency-cruiser.cjs
└── CLAUDE.md  README.md
```

## `apps/api`

```
src/
├── main.ts                       # старт по ROLE; graceful shutdown
├── app.ts                        # сборка Fastify: плагины, модули, маршруты, ws
├── kernel/                       # см. 02-platform-kernel.md; каждый подкаталог: service, repo, http?, events?, __tests__
├── modules/<module>/             # module.ts, public.ts, domain/, infra/, http/, jobs/, events/, __tests__/
├── shared/
│   ├── db/                       # drizzle client, schema index, транзакции, миграции runner
│   ├── config/                   # env-схема (zod), типизированный конфиг
│   ├── http/                     # ошибки problem+json, auth-хуки, пагинация, rate limit
│   ├── logger/ telemetry/ errors/ utils/
├── drizzle/                      # схема (по модулям: schema/kernel.ts, schema/data.ts, …) и миграции
└── test/                         # интеграционные тесты (testcontainers), фикстуры
```

Правила:
- Маршрут = `route(schema, handler)` с обязательным `auth: {action, objectParam}` или `auth: 'public'|'session'`; регистрация без `auth` падает на старте.
- Сервисы принимают `ctx: UserCtx` первым аргументом; `SystemCtx` — только для worker/engine-заданий и явно логируется.
- Репозитории — единственное место SQL модуля; кросс-модульные выборки для списков — через ядро (`objects`) и `public.ts`.
- Транзакции — `db.transaction(async tx => …)`; `ObjectService`, `EventPublisher` принимают `tx`.

## `apps/web`

```
src/
├── app/                          # оболочка: router, providers, workspace (tabs, panes, panels), command palette, shortcuts, realtime client, view-context
├── features/<module>/            # экраны и компоненты модуля: screens/, components/, api/ (hooks над openapi-fetch), model/ (zustand), routes.tsx
├── entities/                     # общие сущностные компоненты: ObjectChip, ObjectCard, UserChip, TerritoryChip, pickers
├── shared/                       # api-client, auth, i18n init, utils, hooks
├── print/                        # маршруты печати без оболочки
└── main.tsx
```

Правила: компоненты UI только из `@kchs/ui`; серверное состояние — TanStack Query с ключами `['objectType', id, …]`; инвалидация по realtime `object.updated`; состояние вкладки — в `app/workspace/tab-state` (Zustand, персист); модуль регистрирует свои маршруты, типы объектов (клиентское описание: иконка, открытие, превью) и команды палитры в `features/<module>/module.ts`.

## `apps/engine`

```
engine/
├── kchs_engine/
│   ├── main.py                   # FastAPI (внутренний: /health, /analyze-file, /preview) + запуск воркеров
│   ├── jobs/                     # обработчики BullMQ: imports, exports, transform, render, media, ai, index
│   ├── data/                     # чтение форматов, типизация, staging, DuckDB
│   ├── gis/                      # GDAL/pyogrio, проекции, валидация, анализ
│   ├── docs/                     # docxtpl, LibreOffice, OCR, извлечение текста
│   ├── media/                    # whisper, ffmpeg
│   ├── ai/                       # провайдеры, эмбеддинги, промпты
│   ├── render/                   # Playwright
│   └── db.py  s3.py  config.py
├── tests/
└── pyproject.toml (uv), Dockerfile (с GDAL, LibreOffice, tesseract, ffmpeg)
```

Правила: engine не принимает решений о правах — задания приходят с уже проверенным контекстом и явными идентификаторами; все результаты пишутся через API-контракты (таблицы `ds.*` через выделенные функции, метаданные — через `api` внутренний эндпоинт `POST /internal/jobs/{id}/result` с сервисным токеном) — **Рекомендовано**: engine пишет строки датасетов напрямую в `ds.*` (производительность `COPY`), а метаданные (версии, статусы) — через внутренний API.

## Соглашения кода

- TypeScript strict, `noUncheckedIndexedAccess`; ESM; импорты через алиасы `@kchs/*`.
- Именование: файлы `kebab-case.ts`, типы/классы `PascalCase`, функции/переменные `camelCase`, БД `snake_case`, события `domain.entity.verb`, i18n-ключи `module.screen.element`.
- Biome для форматирования/линта; `dependency-cruiser` для границ (`modules/*` → только `kernel`, `shared`, `packages`, `modules/*/public`); `knip` для мёртвого кода.
- Ошибки: классы `AppError(code, status, details)`; никаких `throw new Error('...')` в доменной логике.
- Логи: pino, уровни, `requestId`; без персональных данных.
- Тесты рядом с кодом (`__tests__`), интеграционные в `test/`, e2e в `apps/web/e2e`.
- Коммиты: Conventional Commits (`feat(data): …`, `fix(gis): …`); ветки `phase/<n>-<epic>`; PR с описанием и ссылкой на историю бэклога.
- Каждая история бэклога → обновление `docs/progress.md`.

## Конфигурация

`.env` (zod-валидация при старте): `DATABASE_URL`, `DATABASE_QUERY_URL` (роль kchs_query), `REDIS_URL`, `S3_*`, `MEILI_*`, `LIVEKIT_*`, `KCHS_MASTER_KEY`, `KCHS_BASE_URL`, `SMTP_*`, `TELEGRAM_BOT_TOKEN`, `AI_PROVIDER`, `ANTHROPIC_API_KEY`/`OPENAI_COMPAT_URL`, `ENGINE_INTERNAL_URL`, `INTERNAL_SERVICE_TOKEN`, `ROLE`. Секреты — только через окружение/менеджер, не в репозитории.

## CI (GitHub Actions)

`lint` → `typecheck` → `test:unit` → `test:integration` (services: postgres/postgis, redis, meilisearch, minio) → `build` (web, api, engine образы) → `e2e:smoke` (compose up на runner) → `trivy` → (staging) `zap-baseline`, `k6-smoke`. Кэш pnpm/turbo. Релиз — тег → образы в реестр → `compose pull` на сервере.

## Скрипты (`package.json`, корень)

`dev` (turbo: api, web, worker; engine — через compose profile dev), `build`, `test`, `test:integration`, `e2e`, `lint`, `typecheck`, `db:generate`, `db:migrate`, `db:seed`, `db:reset`, `storybook`, `openapi:gen`, `i18n:check` (отсутствующие ключи), `deps:check` (границы), `release`.
