# Технологический стек и обоснование

Статус: **Решено** для основы (языки, БД, фреймворки, ключевые библиотеки); **Рекомендовано** для вспомогательных библиотек (исполнитель может заменить эквивалентом, зафиксировав ADR).

## Критерии выбора

1. Поддержка потребностей продукта (данные, гео, документы, realtime, медиа).
2. Простота эксплуатации on-premise малой командой: минимум сервисов, всё в Docker.
3. Зрелость, документация и распространённость — исполнитель (ИИ-агент) работает быстрее и точнее с широко известными инструментами.
4. Единый язык там, где это возможно (TypeScript на клиенте и сервере), Python только там, где библиотеки решают.
5. Лицензии: открытые (MIT/Apache/BSD/PostgreSQL/MPL); без платных редакций для базовой функциональности.

## Сводная таблица

| Область | Выбор | Альтернативы | Почему |
|---|---|---|---|
| Язык сервера | **TypeScript (Node.js 22 LTS)** | Go, Python, Java/Kotlin | общие типы/контракты с клиентом; экосистема; скорость разработки; тяжёлое вынесено в Python и Postgres |
| HTTP-фреймворк | **Fastify 5** + `fastify-type-provider-zod`, `@fastify/websocket` через Socket.IO | NestJS, Hono, Express | быстрый, типизированный, генерация OpenAPI из zod; NestJS — избыточные абстракции, DI не нужен при явных модулях |
| Валидация/контракты | **zod 4** | typebox, io-ts | единая схема → типы, валидация, OpenAPI, формы |
| ORM/миграции | **Drizzle ORM + Drizzle Kit** | Prisma, Kysely, TypeORM | SQL-близкий, лёгкий, `sql` для PostGIS, миграции; Prisma слаб в динамическом/гео SQL |
| Парсер SQL | **libpg-query** (WASM) | node-sql-parser | настоящий парсер Postgres — единственный надёжный способ проверять сырой SQL |
| БД | **PostgreSQL 17 + PostGIS 3.5 + pgvector + pg_trgm** | MySQL, ClickHouse, отдельная гео-БД | одна система записи для всего; PostGIS — лучший открытый гео-движок; pgvector для семантики |
| Колоночный tier (S2+) | **DuckDB + Parquet в S3** (в engine) | ClickHouse | встраиваемый, нулевая эксплуатация, spatial-расширение; ClickHouse — при потоках телеметрии |
| Очереди/кэш | **Redis 7 + BullMQ** (TS и Python-клиент) | RabbitMQ, NATS, pg-boss | один Redis для очередей, pub/sub, кэша; BullMQ имеет Python-клиент для engine |
| Шина событий | **Transactional outbox → Redis Streams** | Kafka, NATS JetStream | надёжность без Kafka; объёмы событий умеренные |
| Объектное хранилище | **MinIO** (S3 API) | локальный диск, Ceph | стандарт S3, репликация, подписанные URL |
| Поиск | **Meilisearch** | Postgres FTS, OpenSearch, Typesense | мгновенный, опечатки, фасеты, кириллица; один бинарник; OpenSearch тяжёл |
| Realtime | **Socket.IO + Redis adapter** | ws, SSE, Centrifugo | комнаты, переподключение, масштабирование; известен |
| Совместное редактирование | **Yjs + Hocuspocus + Tiptap** | ProseMirror-collab, CRDT самописно | зрелая связка |
| Rich-text | **Tiptap 3** | Slate, Lexical | расширяемость, Yjs, таблицы, упоминания |
| Код-редактор | **CodeMirror 6** | Monaco | лёгкий, кастомные языки (выражения), мобильный |
| Медиа | **LiveKit** (server, egress, client SDK) | Jitsi, mediasoup, Janus | SFU с полным SDK, записью, TURN, SIP; Jitsi трудно встроить глубоко, mediasoup требует писать сервер |
| Клиент | **React 19 + TypeScript + Vite** | Next.js, Vue, Svelte, Angular | SPA рабочего пространства не нуждается в SSR; экосистема компонентов |
| Маршрутизация | **TanStack Router** | React Router | типобезопасные маршруты и поиск-параметры — важно для вкладок и состояния |
| Данные на клиенте | **TanStack Query** + **Zustand** (оболочка, ViewContext) | Redux, MobX, Jotai | кэш серверного состояния + лёгкое локальное |
| Формы | **react-hook-form + zod** | Formik | производительность, схемы |
| Стили и компоненты | **Tailwind CSS 4 + Radix Primitives** (собственная дизайн-система в `packages/ui`, паттерн shadcn) | MUI, Ant Design, Mantine, Chakra | полный контроль над премиальным видом; доступность из Radix; готовые библиотеки выглядят «как все» и мешают плотности |
| Таблицы | **TanStack Table + TanStack Virtual** (собственный `DataGrid`) | AG Grid, Glide Data Grid | единый стиль, MIT, виртуализация по обеим осям; AG Grid Community лишён группировок/pivot, Enterprise платный; резервный путь — AG Grid, если собственный grid не достигнет целей производительности (ADR-0008) |
| Графики | **Apache ECharts 6** через `ChartSpec` | Vega-Lite, Plotly, Recharts, visx | богатые интерактивы, canvas-производительность, темы; собственный спек изолирует библиотеку |
| Карты | **MapLibre GL JS 5** + `terra-draw` + `@turf/turf`; **deck.gl** (S2, тяжёлые визуализации) | Leaflet, OpenLayers, Cesium | WebGL-векторные тайлы, стили, 3D; OpenLayers мощнее в WMS/проекциях, но тяжелее визуально; Cesium — 3D-глобус, не нужен |
| Базовые карты | **PMTiles (Planetiler) + стили OpenMapTiles-схемы** | MapTiler/облачные | оффлайн, бесплатно, самодостаточно |
| Тайл-сервер | **встроенный в API (ST_AsMVT)**; **Martin** для S2 | pg_tileserv, TileServer GL | контроль прав и фильтров; Martin — производительность для статичных слоёв |
| Растры (фаза 3) | **TiTiler** (COG) | GeoServer, MapServer | лёгкий, современный; GeoServer — тяжёлая Java |
| Геокодер | внутренний индекс + **Photon**/Nominatim (опц.) | Pelias | простота |
| Маршрутизация (фаза 3) | **Valhalla** или OSRM | GraphHopper | изохроны, самостоятельно |
| Движок (Python) | **Python 3.12, FastAPI (внутренний), uv, ruff, pytest** | — | pandas/pyarrow/polars, DuckDB, pyogrio/GDAL, shapely, openpyxl, docxtpl, LibreOffice headless, tesseract/ocrmypdf, faster-whisper, sentence-transformers (bge-m3), Playwright |
| ИИ | **Anthropic SDK** + OpenAI-совместимый клиент (on-prem vLLM/Ollama) | — | сменяемый провайдер, структурированные ответы |
| Почта | nodemailer (SMTP), imapflow (IMAP), mjml/react-email для шаблонов | — | стандарт |
| Telegram | grammY | telegraf | современный, типизированный |
| Аутентификация | собственная (argon2 via `@node-rs/argon2`, `otplib`, `@simplewebauthn/server`, `openid-client`, `ldapts`) | Keycloak, Auth.js | продукту нужны своя модель пользователей/структуры и UX; Keycloak — лишний сервис; OIDC-клиент даёт SSO |
| i18n | i18next + ICU (`i18next-icu`), Intl API | FormatJS | распространён; ICU для склонений |
| Логи/метрики/трассы | pino, OpenTelemetry, Prometheus, Grafana, Loki, Tempo; GlitchTip/Sentry | — | стандарт |
| Тесты | vitest, testcontainers, supertest, Playwright (e2e), Storybook + Playwright-скриншоты, k6, axe-core; pytest в engine | jest, cypress | скорость и совместимость с Vite |
| Монорепо/сборка | **pnpm workspaces + Turborepo** | Nx, npm workspaces | простота, кэш задач |
| Качество кода | **Biome** (lint+format), `dependency-cruiser` (границы), `tsc --noEmit` strict, `knip` (мёртвый код) | ESLint+Prettier | скорость и одна конфигурация; ESLint допустим как альтернатива при необходимости специфичных правил |
| CI | GitHub Actions (или GitLab CI) — матрица: lint, typecheck, unit, integration (testcontainers), e2e (smoke), build образов, Trivy, ZAP baseline (staging) | — | — |
| Инфраструктура | Docker Compose (S1), Helm (S2), Caddy (TLS/прокси) | nginx, Traefik | Caddy — автоматический TLS и простая конфигурация |
| Шрифты | **Inter** (переменный, кириллица), **JetBrains Mono** | Golos, Manrope, IBM Plex | качество кириллицы, табличные цифры; самостоятельное размещение |
| Иконки | **Lucide** + собственные глифы модулей | Phosphor, Tabler | единая толщина штриха |

## Версии (на дату проектирования, сентябрь 2026)

Исполнитель фиксирует точные версии в lockfile при старте фазы 0 и записывает их в `docs/progress.md`. Правило: последняя стабильная мажорная версия; обновления мажорных версий — отдельной задачей с тестами.

## Что осознанно не используем

- **Next.js/SSR** — рабочее пространство целиком за аутентификацией, SEO не нужен, SSR усложняет состояние вкладок и карты.
- **GraphQL** — гибкость не нужна при одном клиенте; REST + OpenAPI проще для интеграций и ИИ-инструментов.
- **tRPC** — только для TS-клиентов; публичное API и Python-движок требуют OpenAPI. Одна поверхность API.
- **Kafka** — объём событий не оправдывает эксплуатацию.
- **Camunda/Temporal** — свой движок процессов покрывает потребности; Temporal — вариант, если появятся длительные оркестрации с компенсациями (ADR-0012).
- **Keycloak** — лишний сервис; при появлении требования единого IdP для других систем — подключается как OIDC-провайдер.
- **Elasticsearch/OpenSearch** — Meilisearch достаточно; переключение через порт `SearchIndex`.
