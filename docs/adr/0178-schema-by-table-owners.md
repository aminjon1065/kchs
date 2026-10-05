# 0178. Схема БД — у владельцев таблиц; владение проверяет dependency-cruiser

Статус: Принято
Дата: 2026-10-05
Согласовано владельцем продукта 05.10.2026: решение меняет структуру со статусом «Решено» в
`04-delivery/01-project-structure.md` (была «`drizzle/` — схема по модулям»).

## Контекст

Все 165 таблиц были описаны в `apps/api/src/shared/db/schema/*.ts` и подключались одним
реэкспортом `shared/db/schema/index.ts` (257 импортов). Каталог `shared` разрешён всем, поэтому
правило 4 CLAUDE.md («модули не читают чужие таблицы») не проверялось ничем. Нарушения
копились: chat писал таблицы обсуждений ядра, reports жил в таблицах из `schema/data.ts`, ядро
читало таблицы identity, data — таблицу интеграций (разбор архитектуры 05.10.2026, находка 10).

## Решение

- **Таблица описана у владельца.** Область ядра — `src/kernel/<область>/schema.ts`, модуль —
  `src/modules/<модуль>/schema.ts`. Имена таблиц и столбцов не менялись: `drizzle-kit generate`
  после переноса — «No schema changes».

  | Владелец | Таблицы |
  |---|---|
  | `kernel/objects` | objects, object_ancestors, favorites, recent_views, subscriptions |
  | `kernel/directory` | users, org_units, org_closure, positions, employments, groups, group_members, roles, user_roles, role_capabilities, delegations |
  | `kernel/spaces`, `access`, `links`, `tags` | spaces, space_members; acl_entries, share_links; links, dependencies; tags, object_tags |
  | `kernel/discussions` | conversations, conversation_members, messages, reactions |
  | `kernel/activity`, `audit`, `notifications`, `inbox` | activities; audit_log; notifications, notification_preferences; inbox_items |
  | `kernel/jobs`, `process`, `schedules` | jobs; process_definitions, process_instances, process_steps, process_step_actions; schedules |
  | `kernel/events`, `collab`, `backup`, `search` | ops.outbox, ops.event_consumptions; yjs.documents; ops.backups; embeddings |
  | `kernel/views`, `settings`, `business-calendar`, `announcements`, `acknowledgments` | по одной–две таблицы области |
  | `modules/identity` | вход: credentials, sessions, mfa_*, recovery_codes, password_resets, webauthn_*, sso_*, auth_providers, directory_syncs |
  | `modules/integrations` | integrations, integration_syncs, webhooks, webhook_deliveries, api_tokens |
  | `modules/reports` | reports, report_versions, report_runs |
  | остальные модули | свои таблицы (data, documents, tasks, gis с базовыми картами и слоями служб, …) |

  Помощники столбцов (схемы `ops`/`yjs`/`ds`, `timestamptz`, `createdAt`, jsonb-помощники,
  `LangTextValue`, `bytea`) — `src/shared/db/columns.ts`.
- **Сборщик всей схемы — `src/db-schema.ts`**, не в `shared`: он импортирует ядро и модули, а
  `shared` — лист. Его используют только drizzle-kit (`drizzle.config.ts`), сид, CLI и тесты.
  Тест `src/db-schema.test.ts` сверяет его со всеми `schema.ts` владельцев: забытая схема
  означала бы таблицу без миграции.
- **Клиент БД без описания схемы.** `db.query.<таблица>` больше не используется: три вызова
  заменены обычными `select`, `Database = PostgresJsDatabase`. Иначе `shared/db/client.ts`
  зависел бы от всех владельцев.
- **Правила dependency-cruiser** (`apps/api/.dependency-cruiser.cjs`):
  - `module-tables-owned` — таблицы модуля импортирует только он сам, другим — его
    `public.ts`. Схема модуля может ссылаться на чужую таблицу внешним ключом (forms → datasets,
    alerts → metrics);
  - `kernel-tables-via-services` — модули из таблиц ядра напрямую читают только реестр
    объектов (соединения списков) и, до переноса сервисов справочника в ядро, `kernel/directory`.
    Схема модуля может ссылаться на таблицы ядра внешним ключом;
  - `db-schema-for-tooling` — сборщик не импортируют ни ядро, ни модули, ни `shared`;
  - `shared-is-leaf` — `shared` не зависит и от CLI, сида и сборщика;
  - `modules-only-via-public` пропускает `schema.ts` к правилу `module-tables-owned`.
- **База известных нарушений** — `apps/api/.dependency-cruiser-known-violations.json`:
  `pnpm deps:check` падает только на новых, `pnpm --filter @kchs/api deps:baseline` обновляет базу
  после снятия нарушения. В базе 15 нарушений `kernel-tables-via-services`:

  | Кто | Чьи таблицы | Чем снимается |
  |---|---|---|
  | chat (`chat-queries`, `chat-service`, `chat-subscribers`, `message-search`, `pins`, `quick-actions`) | обсуждения ядра | chat пишет и читает через `DiscussionService` — часть этапа 2 «ядро без словаря модулей» |
  | documents (`participants`) | acl_entries | `listEffectiveAccess` / `usersWithAccess` ядра |
  | documents (`print/forms/office-sheets`, `route-sheets`) | acknowledgment_requests, process_instances | API ознакомлений и маршрутов ядра |
  | documents (`registry`, `territory-documents`), data (`feed-service`) | links, dependencies | `LinkService` ядра |
  | automation (`rule-service`), chat (`quick-actions`), identity (`me-routes`) | spaces | `SpaceService` ядра |

  Временное исключение без записи в базе — справочник: модули читают `kernel/directory`
  напрямую, а сервисы identity пишут его таблицы. Оно снимается переносом сервисов справочника
  (`UserService`, `OrgService`, `GroupService`, должности, замещения) в `kernel/directory` —
  после этого `kernel/directory/schema.ts` уходит из разрешённых модулям. Снято ADR-0179:
  справочник напрямую читает только модуль входа identity (правило `identity-kernel-tables`).
- **Попутные переносы.**
  - Перешифровка секретов мастер-ключом — `src/cli/rotation.ts` (была `shared/crypto/rotation.ts`):
    это инструмент CLI, которому нужны таблицы многих владельцев.
  - Очистка базы (`pnpm db:reset`) — `src/cli/db-reset.ts` (была `shared/db/reset-cli.ts`): она
    вызывает сид.
  - data берёт имя и вид интеграции из `Integrations.get`, а не из таблицы integrations.

## Альтернативы

- **Схема остаётся в `shared`, а импорт таблиц проверяет скрипт по именам.** Владение не видно
  из структуры кода, скрипт хрупкий и дублирует то, что dependency-cruiser делает по путям.
- **Сборщик в `shared`.** Нарушил бы `shared-is-leaf`: `shared` импортировал бы ядро и модули.
- **Схема в `drizzle/` по модулям** (как было записано в структуре проекта). Таблицы лежали бы
  отдельно от кода владельца, а правила границ пришлось бы описывать отдельно от путей модулей.

## Последствия

- Новая таблица — в `schema.ts` владельца и строкой в `src/db-schema.ts` (иначе падает
  `db-schema.test.ts`).
- Миграций нет: перенос только кода.
- Обход владельца виден на ревью и падает в CI. Список известных нарушений сокращается
  частями этапа 2 (`04-delivery/07-architecture-hardening.md`).
