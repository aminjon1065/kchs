# CLAUDE.md — инструкции для исполнителя (Claude Code)

Ты реализуешь **kchs** — корпоративную платформу с аналитическим и GIS-ядром. Проект спроектирован заранее; проектная документация в `docs/` является источником истины для продуктовых и архитектурных решений.

## С чего начать

1. Прочитай `docs/00-start-here.md` — там порядок чтения и принципы.
2. Прочитай `docs/04-delivery/06-handoff.md` — первые шаги и правила работы.
3. Реализуй по `docs/04-delivery/02-roadmap.md` и `docs/04-delivery/03-backlog.md`, фаза за фазой. Не перескакивай через фазу 0 (ядро платформы).

## Незыблемые правила

1. **Каждая доменная сущность — это объект реестра.** Создание любого объекта (датасет, документ, задача, карта, файл…) идёт через `ObjectService` ядра в той же транзакции. Никаких «сущностей вне реестра».
2. **Доступ проверяется только через `authorize()` ядра** и предикаты видимости из политики типа объекта. Никаких ручных `if (user.role === 'admin')` в модулях.
3. **Каждая запись в БД, меняющая состояние, публикует доменное событие через outbox** в той же транзакции. Уведомления, поиск, активность, автоматизация, realtime — только подписчики событий.
4. **Модули не читают чужие таблицы.** Взаимодействие — через публичные API модулей (`modules/<name>/public.ts`), сервисы ядра или события. Границы проверяются `dependency-cruiser` в CI.
5. **SQL только параметризованный.** Динамический SQL для датасетов — только через компилятор `packages/query`. Сырой SQL пользователей — только через парсер `libpg-query`, ограниченную роль БД и переписывание с учётом политик строк.
6. **UI только из дизайн-системы `packages/ui`.** Никаких ad-hoc стилей, цветов, отступов вне токенов. Все тексты — через i18n (`ru` — основной, `tg`, `en`).
7. **Все спецификации из `docs/contracts/` — контракты.** Изменение контракта = запись ADR + обновление документа + миграция данных.
8. **Каждая фаза завершается рабочим продуктом**: приложение запускается через `docker compose up`, seed-данные загружаются, сценарии приёмки фазы проходят (`docs/04-delivery/04-verification.md`).

## Как принимать решения

- Решение описано в `docs/` со статусом **Решено** — выполняй как написано.
- Статус **Рекомендовано** — выполняй как написано, если нет веской причины; отклонение оформляй как ADR в `docs/adr/` с объяснением.
- Статус **Открыто** — прими разумное решение сам, зафиксируй ADR, продолжай. Не блокируйся.
- Локальные детали реализации (внутренняя структура компонента, имена приватных функций, выбор вспомогательной библиотеки) — на твоё усмотрение, в рамках стека из `docs/02-architecture/18-tech-stack.md`.

## Ведение журнала

- `docs/progress.md` — краткий журнал: что сделано, что в работе, что отложено (обновляй по завершении каждого эпика).
- `docs/adr/NNNN-*.md` — новые решения (шаблон в `docs/adr/README.md`).
- Вопросы к владельцу продукта складывай в `docs/04-delivery/05-risks-and-open-questions.md`, раздел «Новые вопросы», и продолжай работу с разумным допущением.

## Команды

Разработка: инфраструктура в Docker, api/worker и web на хосте.

```bash
bash infra/scripts/generate-secrets.sh   # .env со случайными секретами (один раз; --force — заново)
pnpm install                             # зависимости монорепо
docker compose up -d --wait              # postgres/postgis, redis, minio, meilisearch, mailpit
pnpm db:migrate                          # миграции Postgres
pnpm db:seed                             # демо-данные: admin / SEED_ADMIN_PASSWORD, user001…user060
pnpm dev                                 # api с worker (ROLE=all, :3000) и web (:5173)
docker compose up -d --wait engine       # движок (превью, геоформаты, OCR), если нужен
docker compose --profile office up -d --wait onlyoffice  # сервер документов (ADR-0112), если нужен
pnpm db:seed --data=small                # + демо-датасеты генератора при запущенных api и engine (demo — 5 млн строк, ADR-0063)
docker compose --profile observability up -d  # трассы, метрики, журналы; Grafana :3001 (ADR-0045)
```

Проверки (как в CI, `.github/workflows/ci.yml`):

```bash
pnpm lint && pnpm typecheck && pnpm deps:check && pnpm knip
pnpm i18n:check && pnpm i18n:literals
pnpm --filter @kchs/ui contrast && pnpm --filter @kchs/ui tokens
pnpm --filter @kchs/ui test:visual       # снимки историй в двух темах и axe (Docker)
pnpm --filter @kchs/contracts gen:engine # контракты движка; git diff должен быть пустым
pnpm test                                # unit
pnpm test:integration                    # интеграционные (база kchs_test)
bash apps/api/scripts/test-slot.sh N && KCHS_TEST_SLOT=N pnpm --filter @kchs/api test:integration  # своя база kchs_test_N (N = 1…14)
pnpm e2e                                 # Playwright (нужны api и web)
bash infra/scripts/smoke-api.sh          # дымовой прогон API на демо-данных
bash infra/perf/run-k6.sh                # бюджеты p95 API (k6 в Docker) на демо-данных
helm lint infra/helm/kchs -f infra/helm/kchs/ci/external-values.yaml  # чарт S2 (ADR-0118)
docker run --rm -v "$PWD/infra/observability/prometheus:/etc/prometheus:ro" -w /etc/prometheus \
  --entrypoint promtool prom/prometheus:v3.9.1 test rules alerts.test.yml  # правила оповещений (ADR-0147)
```

Кластер S2 (ADR-0118, `infra/helm/README.md`) и нагрузка его масштаба (ADR-0119):

```bash
helm upgrade --install kchs infra/helm/kchs -f infra/helm/kchs/ci/embedded-values.yaml --wait
KCHS_PERF_API=https://kchs.example.org/api/v1 KCHS_PERF_PROFILE=s2-mixed bash infra/perf/run-k6.sh
```

Установка целиком в контейнерах (профиль `app`, вход через web — Caddy со сборкой SPA, ADR-0044):

```bash
bash infra/scripts/generate-secrets.sh --mode app
docker compose --profile app up -d --build --wait
docker compose exec api kchs init --admin-email admin@example.org   # временный пароль — один раз
docker compose exec api kchs seed                                   # демо-данные, по желанию
bash infra/scripts/verify-stack.sh       # вся цепочка на отдельном проекте compose с чистыми томами
```

`kchs` локально — `pnpm kchs init|migrate|seed`. Образ api — бандл esbuild
(`apps/api/scripts/build.mjs`): новая обязательная переменная окружения api должна попасть
в `x-app-env` в `infra/compose/docker-compose.yml`.
