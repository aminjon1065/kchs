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
├── kernel/                       # см. 02-platform-kernel.md; каждый подкаталог: service, repo, schema.ts (свои таблицы), http?, events?, __tests__
├── modules/<module>/             # module.ts, public.ts, schema.ts (таблицы модуля), domain/, infra/, http/, jobs/, events/, __tests__/; слои без колец — ADR-0181
├── db-schema.ts                  # сборка схем владельцев — только для drizzle-kit, сида, CLI и тестов (ADR-0178)
├── shared/
│   ├── db/                       # drizzle client, помощники столбцов (columns.ts), транзакции, миграции runner
│   ├── config/                   # env-схема (zod), типизированный конфиг
│   ├── http/                     # ошибки problem+json, auth-хуки, пагинация, rate limit
│   ├── logger/ telemetry/ errors/ utils/
├── drizzle/                      # миграции и снимки drizzle-kit (схема — у владельцев таблиц, ADR-0178)
└── test/                         # интеграционные тесты (testcontainers), фикстуры
```

Правила:
- Маршрут = `route(schema, handler)` с обязательным `auth: {action, objectParam}` или `auth: 'public'|'session'`; регистрация без `auth` падает на старте.
- Сервисы принимают `ctx: UserCtx` первым аргументом; `SystemCtx` — только для worker/engine-заданий и явно логируется.
- Репозитории — единственное место SQL модуля; кросс-модульные выборки для списков — через ядро (`objects`) и `public.ts`.
- Таблица описана у владельца (ADR-0178, согласовано владельцем продукта 05.10.2026): область ядра — `kernel/<область>/schema.ts`, модуль — `modules/<модуль>/schema.ts`. Модуль импортирует только свою схему; из таблиц ядра напрямую — реестр объектов (`kernel/objects/schema.ts`) и, до переноса сервисов справочника в ядро, `kernel/directory/schema.ts`; схема модуля может ссылаться на чужую таблицу внешним ключом. Сборщик `src/db-schema.ts` — только для drizzle-kit, сида, CLI и тестов. Проверяет dependency-cruiser (`pnpm deps:check`, база известных нарушений — `.dependency-cruiser-known-violations.json`).
- Транзакции — `db.transaction(async tx => …)`; `ObjectService`, `EventPublisher` принимают `tx`.

## `apps/web`

```
src/
├── app/                          # оболочка: providers, рабочее пространство (вкладки, панели, рейка, палитра, контекст-панель), точка сборки модулей app/modules.tsx
├── features/<module>/            # экраны и компоненты модуля; module.ts(x) — что модуль даёт оболочке; index.ts — публичный вход для других фич (запросы, ключи, подписи)
├── entities/                     # сквозные компоненты сущностей: доступ, выбор людей и объектов, присутствие, загрузка и превью файлов, совместная правка, сообщения
├── shared/                       # клиент API, перевод (useT, useLocale), оформление, realtime, состояние рабочего пространства и реестр модулей (shared/workspace)
└── main.tsx
```

Правила (ADR-0183, `apps/web/.dependency-cruiser.cjs`, `pnpm deps:check`):
- слои снизу вверх `shared` → `entities` → `features` → `app`; нижний слой не импортирует верхний;
- чужая фича — только через `features/<m>/index.ts`; в публичном входе — лёгкие модули, без компонентов;
- оболочка знает фичи только в точке сборки `app/modules.tsx`: модуль описывает себя `ModuleDefinition`
  (экраны, представления объектов, пункты навигации, возможности оболочки, слои) и регистрируется
  `registerModule`; рейка, палитра, shell и контекст-панель читают реестр;
- обращения к API — в слое запросов фичи (`api/`, `queries.ts`), в `entities` и `shared`;
- нарушения, бывшие до правил, — база известных (`.dependency-cruiser-known-violations.json`), новые
  роняют CI.

Остальное: компоненты UI только из `@kchs/ui`; серверное состояние — TanStack Query с ключами
`['objectType', id, …]`; инвалидация по realtime `object.updated` (все запросы с id объекта в ключе);
состояние вкладки — `setTabState` хранилища `shared/workspace/store.ts` (Zustand, персист).

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

Правила:
- engine не принимает решений о правах: задания приходят с уже проверенным контекстом и явными идентификаторами.
- Результаты и статусы — через внутренние маршруты api (`/internal/jobs/{id}/status` и маршруты ресурсов модулей) токеном своего задания (ADR-0176). Общий сервисный токен проверяет только вызовы api в движок.
- В базу движок не пишет: нормализованный файл импорта кладёт в хранилище, строки в `ds.*` загружает TS-воркер через `COPY` (ADR-0046); читает только ролью `kchs_query` (колоночные копии).
- Права минимальные (ADR-0176): свой пользователь хранилища (новый префикс ключа — правка `infra/compose/minio/engine-policy.json` и `kchs.engineS3Policy` чарта) и Redis (новая очередь движка — строка в `infra/compose/redis/start.sh`, её проверяет тест contracts).
- Внешние программы запускаются с окружением `tools.tool_env()`, а не с окружением движка.

## Соглашения кода

- TypeScript strict, `noUncheckedIndexedAccess`; ESM; импорты через алиасы `@kchs/*`.
- Именование: файлы `kebab-case.ts`, типы/классы `PascalCase`, функции/переменные `camelCase`, БД `snake_case`, события `domain.entity.verb`, i18n-ключи `module.screen.element`.
- Biome для форматирования/линта; `dependency-cruiser` для границ (`modules/*` → только `kernel`, `shared`, `packages`, `modules/*/public`) и проверка колец между модулями `scripts/module-cycles.mjs` (ADR-0181, слои — `pnpm --filter @kchs/api deps:layers`); `knip` для мёртвого кода.
- Ошибки: классы `AppError(code, status, details)`; никаких `throw new Error('...')` в доменной логике.
- Логи: pino, уровни, `requestId`; без персональных данных.
- Тесты рядом с кодом (`__tests__`), интеграционные в `test/`, e2e в `apps/web/e2e`.
- Коммиты: Conventional Commits (`feat(data): …`, `fix(gis): …`); ветки `phase/<n>-<epic>`; PR с описанием и ссылкой на историю бэклога.
- Каждая история бэклога → обновление `docs/progress.md`.
- Миграции — expand/contract (ADR-0173): новое сначала добавляется и пишется вместе со старым, чтение переходит на него следующим выпуском, старое убирается ещё одним; переименование и удаление того, на что опирается предыдущая версия, в одном выпуске запрещены. Применённую миграцию не правят — мигратор сверяет хэши и не запустится.

## Конфигурация

`.env` (zod-валидация при старте): `DATABASE_URL`, `DATABASE_QUERY_URL` (роль kchs_query), `REDIS_URL`, `S3_*`, `MEILI_*`, `LIVEKIT_*`, `KCHS_MASTER_KEY`, `KCHS_BASE_URL`, `SMTP_*`, `TELEGRAM_BOT_TOKEN`, `AI_PROVIDER`, `ANTHROPIC_API_KEY`/`OPENAI_COMPAT_URL`, `ENGINE_INTERNAL_URL`, `INTERNAL_SERVICE_TOKEN`, `ROLE`. Секреты — только через окружение/менеджер, не в репозитории.

## CI (GitHub Actions)

`lint` → `typecheck` → `test:unit` → `test:integration` (services: postgres/postgis, redis, meilisearch, minio) → `build` (web, api, engine образы) → `e2e:smoke` (compose up на runner) → `trivy` → (staging) `zap-baseline`, `k6-smoke`. Кэш pnpm/turbo. Релиз — тег → образы в реестр → `compose pull` на сервере.

## Скрипты (`package.json`, корень)

`dev` (turbo: api, web, worker; engine — через compose profile dev), `build`, `test`, `test:integration`, `e2e`, `lint`, `typecheck`, `db:generate`, `db:migrate`, `db:seed`, `db:reset`, `storybook`, `openapi:gen`, `i18n:check` (отсутствующие ключи), `deps:check` (границы), `release`.
