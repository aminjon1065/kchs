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
│   ├── i18n/                     # словари ru/tg/en по неймспейсам (locales/<язык>/<неймспейс>.ts), ICU
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
│   ├── http/                     # регистратор маршрутов по таблице контрактов, ошибки problem+json, auth-хуки, пагинация, rate limit
│   ├── logger/ telemetry/ errors/ utils/
├── drizzle/                      # миграции и снимки drizzle-kit (схема — у владельцев таблиц, ADR-0178)
└── test/                         # интеграционные тесты (testcontainers), фикстуры
```

Правила:
- Маршрут = `route({ route: 'GET /tasks/:id', auth, handler })` с обязательным `auth`: `{action, objectParam}`, `{capability}`, `'public'`, `'session'` (без параметров пути) или, если в пути объект, а проверяет сервис, — `{delegated, objectType | resource}`, `{owned}`, `{open}` с причиной (ADR-0186); регистрация без `auth` или `'session'` с параметром пути падает на старте.
- `route` — ключ таблицы маршрутов (ADR-0188). Метод, путь и схемы берутся из записи таблицы, в api остаются политика, обработчик, теги и описание:
  - ядро и модули — `packages/contracts/src/routes/kernel/<область>.ts` и `modules/<модуль>.ts`;
  - движок процессов — `packages/process/src/routes.ts`;
  - полная таблица для api и клиента — `@kchs/process/routes`: значение `routes`, тип `Routes`;
  - тело и ответ маршрутов `/internal/…` — схемы контракта движка `ENGINE_CALLBACKS` (ADR-0190).

  Маршрут без записи не регистрируется, а запись без маршрута не даёт api запуститься. Схемы zod маршрутов в api не живут.
- Сервисы принимают `ctx: UserCtx` первым аргументом; `SystemCtx` — только для worker/engine-заданий и явно логируется.
- Репозитории — единственное место SQL модуля; кросс-модульные выборки для списков — через ядро (`objects`) и `public.ts`.
- Таблица описана у владельца (ADR-0178, согласовано владельцем продукта 05.10.2026): область ядра — `kernel/<область>/schema.ts`, модуль — `modules/<модуль>/schema.ts`. Модуль импортирует только свою схему; схема модуля может ссылаться на чужую таблицу внешним ключом. Сборщик `src/db-schema.ts` — только для drizzle-kit, сида, CLI и тестов.
- Таблицы ядра — только через его сервисы, порты и фрагменты SQL (ADR-0184):
  - напрямую модуль читает лишь `objects`;
  - не хватает чтения или записи — в ядро добавляется метод;
  - исключение — identity: схема справочника и запись столбцов входа и связи с каталогом в `users` (ADR-0179).

  В тексте SQL свои таблицы подставляются `${таблица}`, чужие по имени не называются.
- Текст SQL как есть (`sql.raw`, `.unsafe`) — только в `modules/data/infra`, `shared/db`, `packages/query` и адаптере внешней СУБД `integrations/infra/database-source.ts` (ADR-0184):
  - остальной код пишет шаблоны `sql` с параметрами и фрагментами этих слоёв: `tableSql`/`columnSql` модуля данных, `LinkSql`, `visibleObjectsSql`;
  - текст компилятора выполняется через `readAsQueryRole`;
  - имена экранирует один помощник — `quoteIdent` из `@kchs/query`;
  - новое место — строкой исключения с причиной в `scripts/raw-sql.mjs` и ADR.
- Проверки границ api — `pnpm deps:check`, база известных нарушений у api пуста (ADR-0184), любое нарушение роняет CI:
  - dependency-cruiser — импорты и владение схемами;
  - `scripts/module-cycles.mjs` — кольца модулей;
  - `scripts/table-owners.mjs` — запись в таблицы ядра и чужие таблицы по имени;
  - `scripts/raw-sql.mjs` — сырой SQL вне слоёв.
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
- словари — по неймспейсам (ADR-0191, раздел «Словари» ниже): модуль объявляет нужные ему
  неймспейсы в `registerModule({ namespaces })`, оболочка берёт тексты только из неймспейсов
  оболочки; полноту объявлений проверяет `app/namespaces.test.ts`;
- нарушения, бывшие до правил, — база известных (`.dependency-cruiser-known-violations.json`), новые
  роняют CI.

Остальное: компоненты UI только из `@kchs/ui`; серверное состояние — TanStack Query с ключами
`['objectType', id, …]`; инвалидация по realtime `object.updated` (все запросы с id объекта в ключе);
состояние вкладки — `setTabState` хранилища `shared/workspace/store.ts` (Zustand, персист).

### Словари (`packages/i18n`, ADR-0191)

- **Неймспейс** — ключ верхнего уровня (`data` в `data.explore.title`). Файл —
  `packages/i18n/src/locales/<язык>/<неймспейс>.ts` на каждом из `ru`, `tg`, `en`. Сборка
  языка — `locales/<язык>/index.ts`, перечень — `NAMESPACES`.
- **Неймспейсы оболочки** (`CORE_NAMESPACES`): `common`, `ui`, `errors`, `auth`,
  `shell`, `objects`, `access`, `activity`, `discussion`, `spaces`, `search`, `inbox`,
  `home`, `files`. Их `ru` — в основном чанке веба, `tg` и `en` — чанк на язык
  (`locales/<язык>/core.ts`). Остальные неймспейсы модульные: отдельный чанк на язык.
  Сервер держит всё.
- **Добавить ключ модулю** — правка только файлов его неймспейса на трёх языках. Перевод на
  `tg` и `en` обязателен: в браузере модульный неймспейс грузится только на языке
  интерфейса, без запасного `ru` (`pnpm i18n:check`, 100 % в каждом неймспейсе).
- **Экран берёт чужой неймспейс** — модуль объявляет его в `registerModule({ namespaces })`;
  какой именно, подскажет `app/namespaces.test.ts`. Подпись, которую рисует оболочка
  (`titleKey`, `labelKey`, каркас), — ключ неймспейса оболочки, например `shell.screens.*`.
- **Новый неймспейс:**
  - файлы на трёх языках;
  - строки в индексах языков и в `NAMESPACES`;
  - загрузчики в `packages/i18n/src/loaders.ts`;
  - неймспейс оболочки — ещё `CORE_NAMESPACES` и `core.ts`.

  Сверку файлов, индексов и загрузчиков делает `pnpm i18n:check`.

## `apps/engine`

```
engine/
├── kchs_engine/
│   ├── main.py                   # FastAPI (внутренний: /health, /analyze-file, /preview) + запуск воркеров
│   ├── contracts/                # сгенерированные JSON из packages/contracts и модели заданий и обратных вызовов
│   ├── jobs/                     # обработчики BullMQ своих очередей: imports, transform, render, media
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
- Контракт с api — `packages/contracts` (ADR-0190). Задание движка объявляется в `ENGINE_JOBS`
  (`packages/contracts/src/engine/jobs.ts`): нагрузка и результат — zod; обратный вызов — в
  `ENGINE_CALLBACKS` (тело и ответ — те же схемы, что у маршрута api). `gen:engine` выгружает их
  JSON Schema в `kchs_engine/contracts/jobs.json`. В движке задание описывают модели
  `contracts/jobs.py` и `contracts/callbacks.py`; `@handler` без записи в контракте не регистрируется,
  обработчик проверяет нагрузку на входе и результат на выходе, `api.py` — тело перед отправкой и
  ответ api. Совместимость моделей со схемами проверяет `tests/test_engine_contracts.py`.
- Порядок изменения задания: схема в `packages/contracts` → `gen:engine` → модель движка → тест
  контракта. Api ставит задание через `engineJob()` (`kernel/jobs/engine.ts`), `JobService.schedule`
  разбирает нагрузку схемой до записи в реестр.
- Типы полей движок не перечисляет сам: хранение, тип Arrow, семейство геовыгрузки и слова «да/нет» —
  из `field_types.json` (реестр `FIELD_STORAGE`, `docs/contracts/field-types.md`).
- Статическая проверка — `ruff` и `mypy` (задание CI «Тесты движка»; база исключений — в
  `pyproject.toml`, модуль уходит из неё, когда его ошибки исправлены).

## Соглашения кода

- TypeScript strict, `noUncheckedIndexedAccess`; ESM; импорты через алиасы `@kchs/*`.
- Именование: файлы `kebab-case.ts`, типы/классы `PascalCase`, функции/переменные `camelCase`, БД `snake_case`, события `domain.entity.verb`, i18n-ключи `module.screen.element`.
- Biome для форматирования/линта; `dependency-cruiser` для границ (`modules/*` → только `kernel`, `shared`, `packages`, `modules/*/public`) и проверки api в `pnpm deps:check`:
  - кольца между модулями — `scripts/module-cycles.mjs` (ADR-0181, слои — `pnpm --filter @kchs/api deps:layers`);
  - таблицы у владельцев — `scripts/table-owners.mjs` (ADR-0184);
  - сырой SQL — `scripts/raw-sql.mjs` (ADR-0184).

  `knip` — для мёртвого кода.
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

`dev` (turbo: api, web, worker; engine — через compose profile dev), `build`, `test`, `test:integration`, `e2e`, `lint`, `typecheck`, `db:generate`, `db:migrate`, `db:seed`, `db:reset`, `storybook`, `openapi:gen`, `i18n:check` (перевод tg и en — 100 % в каждом неймспейсе, сверка раскладки словарей), `deps:check` (границы), `release`.
