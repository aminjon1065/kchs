# Физическая модель данных

Статус: **Решено** для схемы хранения датасетов и ядра; конкретные столбцы модулей — **Рекомендовано** (исполнитель детализирует в миграциях Drizzle, сохраняя имена из этого документа и глоссария).

## Общие правила

- PostgreSQL 17, расширения: `postgis`, `postgis_topology` (опц.), `pgvector`, `pg_trgm`, `btree_gist`, `unaccent`, `uuid-ossp`/`gen_random_uuid`.
- Идентификаторы: `uuid` v7 (упорядоченные по времени; генерируются приложением) для объектов и большинства таблиц; `bigint identity` для высокочастотных строк (сообщения, активности, строки датасетов, тайлы).
- Время: `timestamptz` везде; локальные даты (`date`) только для календарных дат.
- Многоязычные подписи справочников: `jsonb {"ru": ..., "tg": ..., "en": ...}`.
- Мягкое удаление только на уровне `objects` (`deleted_at`); дочерние строки удаляются физически при окончательном удалении.
- Все таблицы имеют `created_at`, `updated_at`; изменяемые бизнес-таблицы — `version int` для оптимистичных блокировок (ETag).
- Схемы: `public` (платформа и модули, миграции Drizzle), `ds` (таблицы датасетов, DDL управляется кодом модуля `data`), `ops` (outbox, служебное), `yjs` (документы совместного редактирования).
- Роли БД: `kchs_app` (владелец схем, DML), `kchs_query` (выполнение пользовательских запросов: только `SELECT` на представления в `ds_views`, statement_timeout, work_mem лимит), `kchs_migrator` (DDL), `kchs_readonly` (BI/резерв), `kchs_audit` (только INSERT в `audit_log`).

## Ядро

```sql
objects(id uuid pk, type text, space_id uuid, parent_id uuid null, title text, subtitle text, icon text,
        owner_id uuid, created_by uuid, created_at, updated_at, archived_at, deleted_at,
        access_mode text default 'inherit', meta jsonb default '{}', search_version bigint, version int)
  idx: (space_id, type, deleted_at), (parent_id), (owner_id), (type, updated_at desc), gin(meta jsonb_path_ops), trgm(title)

object_ancestors(object_id, ancestor_id, depth)  pk(object_id, ancestor_id)  idx(ancestor_id)

spaces(id pk → objects, key text unique, kind text, unit_id uuid null, settings jsonb)
space_members(space_id, user_id, role text, added_by, added_at)  pk(space_id, user_id)

acl_entries(id, object_id, principal_type text, principal_id text, level smallint,
            granted_by, granted_at, expires_at, note)  unique(object_id, principal_type, principal_id)
  idx: (principal_type, principal_id), (object_id)

links(id, source_id, target_id, kind text, created_by, created_at, meta jsonb)
  unique(source_id, target_id, kind)  idx(target_id)
dependencies(from_id, to_id, kind text)  pk(from_id, to_id, kind)  idx(to_id)

tags(id, space_id null, name text, color text)      object_tags(object_id, tag_id)
favorites(user_id, object_id, added_at)             recent_views(user_id, object_id, viewed_at)

conversations(id pk → objects, kind text, object_id uuid null unique, privacy text, last_message_at, settings jsonb)
conversation_members(conversation_id, user_id, role, last_read_message_id bigint, muted_until, pinned, joined_at)
messages(id bigint identity pk, conversation_id, author_id, kind text, body jsonb, text tsvector/text,
         reply_to_id, thread_root_id, attachments jsonb, mentions uuid[], edited_at, deleted_at, created_at, meta jsonb)
  idx: (conversation_id, id desc), (thread_root_id), gin(mentions)
reactions(message_id, user_id, emoji, created_at)

activities(id bigint pk, event_id, object_id, space_id, actor_id, verb text, summary jsonb, occurred_at)
  idx: (object_id, id desc), (actor_id, id desc)
audit_log(id bigint pk, occurred_at, actor_id, on_behalf_of, action text, object_id, object_type, ip, user_agent, details jsonb, severity)
  -- только INSERT; партиционирование по месяцам

notifications(id bigint pk, user_id, event_id, category text, title, body, object_id, url, channels jsonb, read_at, created_at)
inbox_items(id, user_id, kind text, object_id, process_step_id null, title, due_at, priority, state text, opened_at, resolved_at, snoozed_until, payload jsonb)
  idx: (user_id, state, due_at)
notification_preferences(user_id, category, channel, mode text)  -- immediate|digest|off
subscriptions(user_id, object_id, level text, source text)

jobs(id uuid, queue text, name text, object_id, initiator_id, status text, progress numeric, message text,
     result jsonb, error jsonb, attempts int, created_at, started_at, finished_at, idempotency_key unique null)

process_definitions(id, key text, version int, object_type text, definition jsonb, published_at, created_by)  unique(key, version)
process_instances(id, definition_id, object_id, status text, context jsonb, started_by, started_at, finished_at, outcome text)
process_steps(id, instance_id, step_key, kind text, status text, assignees jsonb, due_at, started_at, completed_at, result jsonb, sequence int)
process_step_actions(id, step_id, actor_id, on_behalf_of, action text, comment, payload jsonb, at)

views(id pk → objects, object_type text, definition jsonb)   -- filters, sort, group, columns, mode
settings(scope text, scope_id uuid null, key text, value jsonb, updated_by, updated_at)  pk(scope, scope_id, key)
business_calendar(country text, day date, kind text, note)  pk(country, day)

ops.outbox(id bigint identity, event jsonb, created_at, published_at null)  idx(published_at nulls first)
yjs.documents(object_id pk, state bytea, updated_at)
```

## Идентификация

```sql
users(id, login unique, email unique, phone, display_name, first_name, last_name, middle_name, locale, timezone,
      avatar_file_id, status, attributes jsonb, password_changed_at, last_seen_at, created_at, updated_at)
credentials(user_id pk, password_hash text, algo text, failed_attempts, locked_until)
mfa_factors(id, user_id, kind text, secret_enc bytea, name, verified_at, last_used_at)
recovery_codes(user_id, code_hash, used_at)
webauthn_credentials(id, user_id, public_key, counter, transports, name)
sessions(id, user_id, token_hash unique, ip, user_agent, device_name, created_at, last_active_at, expires_at, revoked_at, on_behalf_of null)
password_resets(id, user_id, token_hash, expires_at, used_at)
org_units(id, parent_id, code, name jsonb, kind, head_user_id, deputy_user_ids uuid[], territory_id, sort, external_id, is_active)
org_closure(unit_id, ancestor_id, depth)
positions(id, name jsonb, rank int, unit_id null)
employments(id, user_id, unit_id, position_id, is_primary, starts_at, ends_at)
groups(id, name, kind text, space_id null, description)   group_members(group_id, user_id)
roles(id, key unique, name jsonb, is_system)  role_capabilities(role_id, capability text)  user_roles(user_id, role_id, space_id null)
delegations(id, from_user_id, to_user_id, scope text, starts_at, ends_at, note, status, created_at)
sso_identities(id, user_id, provider text, subject text unique(provider, subject), profile jsonb)
```

## Данные

```sql
sources(id pk → objects, kind text, config jsonb, credentials_enc bytea, status, last_check_at, schedule text)
datasets(id pk → objects, kind text, storage text, source_id, primary_key text[], geometry jsonb, time_field text,
         territory_field text, row_count bigint, current_version int, settings jsonb, description text, steward_id,
         physical_table text, last_import_at, schema_version int)
dataset_fields(id, dataset_id, key text, label jsonb, type text, semantic text, format jsonb, unit text, nullable bool,
               indexed bool, sensitive bool, lookup jsonb, formula text, description, "order" int, physical_column text)
  unique(dataset_id, key)
dataset_versions(id, dataset_id, number int, created_at, created_by, origin text, row_count, diff jsonb, parquet_key, schema_snapshot jsonb)
dataset_relations(id, left_dataset_id, left_field, right_dataset_id, right_field, cardinality, label)
dataset_row_policies(id, dataset_id, principal_type, principal_id, filter jsonb, note)
dataset_column_policies(id, dataset_id, principal_type, principal_id, mode text, fields text[])
imports(id, dataset_id, file_id, status, options jsonb, mapping jsonb, stats jsonb, errors_file_id, job_id, created_by, created_at, finished_at)
pipelines(id pk → objects, definition jsonb, schedule text, last_run_at, status)   pipeline_runs(id, pipeline_id, job_id, status, stats, started_at, finished_at)
queries(id pk → objects, mode text, spec jsonb, sql text, params_schema jsonb, dataset_ids uuid[], compiled_hash text)
query_runs(id bigint, query_id null, user_id, spec_hash, sql_hash, duration_ms, row_count, cached bool, error text, at)
metrics(id pk → objects, dataset_id, definition jsonb, unit, format jsonb, direction text, targets jsonb, thresholds jsonb)
charts(id pk → objects, query_id null, inline_spec jsonb, chart jsonb, params_defaults jsonb)
dashboards(id pk → objects, layout jsonb, tiles jsonb, filters jsonb, refresh_interval int, theme text, settings jsonb)
notebooks(id pk → objects, cells jsonb, params jsonb)      -- тело также в yjs.documents для совместной работы
reports(id pk → objects, template jsonb, params_schema jsonb, output_formats text[], schedule text, distribution jsonb, register_as_type_id)
report_runs(id, report_id, params jsonb, status, output_file_ids jsonb, job_id, created_by, created_at)
forms(id pk → objects, dataset_id, schema jsonb, assignments jsonb, period text, settings jsonb)
form_submissions(id, form_id, period_key text, submitted_by, unit_id, status text, row_ids bigint[], submitted_at, reviewed_by, comment)
alerts(id pk → objects, metric_id, condition jsonb, dimensions jsonb, schedule text, channels jsonb, recipients jsonb, cooldown_minutes, last_fired_at)
alert_events(id, alert_id, fired_at, value numeric, dimension_values jsonb, notified jsonb)
quality_rules(id, dataset_id, kind text, config jsonb, severity)  quality_results(id, rule_id, version_id, passed bool, failed_count, sample jsonb, at)
result_cache (в Redis; ключ = hash(sql, params, dataset versions, policy hash), TTL и инвалидация по версии)
```

### Физические таблицы датасетов

Для датасета с `physical_table = 'ds.t_01hzx3...'`:

```sql
CREATE TABLE ds.t_<sid> (
  _id bigint generated always as identity primary key,
  _ver int not null default 1,
  _created_at timestamptz not null default now(),
  _updated_at timestamptz not null default now(),
  _created_by uuid, _updated_by uuid,
  _deleted_at timestamptz,               -- мягкое удаление строк при track_history
  _import_id uuid,                        -- какой импорт/версия принесла строку
  c_<fieldA> text, c_<fieldB> numeric, c_<fieldC> timestamptz, ... ,
  geom geometry(Geometry, 4326)           -- если есть геометрия; тип фиксируется в метаданных
);
CREATE INDEX ON ds.t_<sid> USING gist (geom);
CREATE INDEX ON ds.t_<sid> (c_<time_field>);         -- по полям с indexed=true
CREATE INDEX ON ds.t_<sid> USING gin (c_<text> gin_trgm_ops);  -- для текстовых поисковых полей
-- для больших полигональных слоёв: geom_s1, geom_s2 (генерализованные для низких зумов), заполняются при импорте
CREATE TABLE ds.h_<sid> (id bigint, row_id bigint, ver int, op char(1), data jsonb, changed_by uuid, changed_at timestamptz);
```

Типы полей → столбцы: `text→text`, `long_text→text`, `number→double precision`, `decimal→numeric(p,s)`, `integer→bigint`, `boolean→boolean`, `date→date`, `datetime→timestamptz`, `time→time`, `select/multi_select→text/text[]` (значения — ключи справочника), `user/unit/territory/object_ref→uuid` (+ индекс), `file→uuid`, `json→jsonb`, `geometry→geometry`, `url/email/phone→text`, `money→numeric(18,2)`, `percent→double precision`, `formula` — не хранится (вычисляется в запросе) либо материализуется по флагу.

Ключевые операции DDL инкапсулированы в `modules/data/infra/physical.ts`: создать таблицу, добавить/переименовать/удалить столбец (переименование не требуется — физическое имя стабильно), сменить тип (через временный столбец и приведение с отчётом об ошибках), создать индексы, `COPY` из staging, `swap` таблиц при полной замене (`ALTER TABLE ... RENAME` в транзакции), `VACUUM ANALYZE` после импорта.

Представления для роли `kchs_query`: компилятор создаёт при необходимости временное представление `ds_views.v_<sid>_<policyhash>` или использует подзапрос в тексте запроса. Решено: **подзапрос** (без DDL при каждом запросе), а роль `kchs_query` получает `SELECT` на схему `ds` только через `SECURITY DEFINER`-функцию `ds_read(table, policy_json)`? — Нет: избыточно. Итог: роль `kchs_query` имеет `SELECT` на `ds.*`, но **все** пользовательские запросы проходят через компилятор/переписыватель, который является единственным путём к этой роли, и выполняются с `SET LOCAL statement_timeout`, `SET LOCAL ROLE kchs_query`. Сырой SQL не допускается к выполнению, если парсер нашёл ссылки на схемы, кроме `ds`, функции записи, или таблицы датасетов без прав. См. `17-security.md`.

## GIS

```sql
layers(id pk → objects, dataset_id, style jsonb, popup_template jsonb, label jsonb, min_zoom, max_zoom, filter jsonb,
       editable bool, moderated bool, tile_fields text[], legend jsonb, settings jsonb)
maps(id pk → objects, basemap_id, view jsonb, layers jsonb, widgets jsonb, bookmarks jsonb, filters_binding jsonb, time jsonb)
basemaps(id pk → objects, kind text, url text, style jsonb, attribution, min_zoom, max_zoom, is_default)
territories(id pk → objects, code text unique, parent_id, level text, name jsonb, geom geometry(MultiPolygon,4326), centroid geometry(Point,4326), area_km2, attributes jsonb, dataset_row_id bigint)
  idx: gist(geom), (parent_id), (level)
territory_closure(territory_id, ancestor_id, depth)
analyses(id pk → objects, kind text, params jsonb, input_dataset_ids uuid[], output_dataset_id, status, job_id)
map_annotations(id, map_id, user_id null, geom geometry, style jsonb, note, created_at)
feature_edits(id bigint, layer_id, row_id, op text, before jsonb, after jsonb, geom_before, geom_after, author_id, status text, reviewed_by, at)
tile_cache — в Redis (ключ layer:version:filterhash:z/x/y, TTL) и/или на диске; для S2 — Varnish/nginx cache перед API
```

## Документы

```sql
document_types(id pk → objects, key, direction text, card_schema jsonb, numbering jsonb, default_route_id, retention_years, confidentiality_allowed text[], print_forms jsonb, settings jsonb)
journals(id pk → objects, name, type_ids uuid[], format text, reset text, unit_id null, is_active)
journal_counters(journal_id, year int, last_seq int)  pk(journal_id, year)
documents(id pk → objects, type_id, status text, reg_number text, reg_date date, journal_id, subject text, summary text,
          correspondent_id, external_number, external_date, author_id, responsible_id, signer_id, deadline date,
          control text, controller_id, confidentiality text, fields jsonb, current_version_id, case_id, territory_id, executed_at, archived_at)
  idx: (type_id, status), (reg_number), (journal_id, reg_date desc), (responsible_id, deadline), gin(fields)
document_versions(id, document_id, number int, main_file_id, pdf_file_id, attachments jsonb, created_by, created_at, note, hash text, is_final)
registrations(id, document_id, journal_id, number text, sequence int, year int, registered_by, registered_at)  unique(journal_id, year, sequence)
approvals(id, document_id, version_id, step_id, approver_id, on_behalf_of, decision text, comment, remarks_file_id, decided_at)
signatures(id, document_id, version_id, signer_id, on_behalf_of, kind text, hash text, signed_at, certificate jsonb, sheet_file_id)
resolutions(id, document_id, author_id, text, responsible_id, co_executors uuid[], deadline date, control bool, controller_id, parent_id, created_at)
acknowledgments(id, object_id, user_id, required_at, acknowledged_at, source text)   -- общая для документов и страниц
cases(id pk → objects, index text, title, year int, retention text, unit_id, status, closed_at)
correspondents(id pk → objects, kind text, name text, details jsonb, contacts jsonb, external_id)
templates(id pk → objects, kind text, file_id, mapping jsonb, document_type_id null)
```

## Файлы, задачи, коммуникации, встречи, календарь, знания, автоматизация

```sql
files(id pk → objects, folder_id null, name, mime, size bigint, storage_key, checksum, current_version_id, preview_status, locked_by, locked_at, text_status)
file_versions(id, file_id, number, storage_key, size, checksum, created_by, created_at, note)
file_texts(file_id pk, text, lang, extracted_at)   file_shares(id, file_id, token, password_hash, expires_at, max_uses, uses, created_by)

projects(id pk → objects, key text unique, lead_id, status, starts_at, ends_at, workflow jsonb, custom_fields jsonb, board_settings jsonb)
tasks(id pk → objects, kind text, key text unique, project_id, parent_id, status text, priority smallint, assignee_id, co_assignees uuid[],
      author_id, controller_id, start_at, due_at, completed_at, accepted_at, requires_acceptance bool, result jsonb,
      source jsonb, estimate_minutes, labels text[], fields jsonb, recurrence jsonb, "order" double precision)
  idx: (assignee_id, status, due_at), (project_id, status), gin(co_assignees), (source->>'object_id')
task_dependencies(task_id, depends_on_id, kind)  checklists(id, task_id, items jsonb)  time_entries(id, task_id, user_id, minutes, day, note)
task_counters(scope text, year int, last_seq int)

meetings(id pk → objects, kind, organizer_id, starts_at, ends_at, room_name unique, status, agenda jsonb, settings jsonb, event_id, livekit jsonb)
meeting_participants(meeting_id, user_id null, guest_name, guest_token, role, invite_status, joined_at, left_at)
recordings(id pk → objects, meeting_id, file_id, duration_s, status, transcript_status)
transcripts(id, recording_id, language, segments jsonb, summary jsonb, model, created_at)
protocols(id pk → objects, meeting_id, status, document_id)   protocol_items(id, protocol_id, kind, text, assignee_id, due_at, task_id, "order")

calendars(id pk → objects, kind, owner_id, color, timezone)
events(id pk → objects, calendar_id, starts_at, ends_at, all_day, rrule, exdates, location, meeting_id, visibility, reminders jsonb, linked_object_ids uuid[])
event_attendees(event_id, user_id, status text, optional bool)   event_instances (материализация повторов на 2 года вперёд для быстрых выборок)

pages(id pk → objects, status, template_key, owners uuid[], review_due_at, ack_required bool, current_version int)
page_versions(id, page_id, number, body jsonb, created_by, created_at, summary)

rules(id pk → objects, trigger jsonb, conditions jsonb, actions jsonb, enabled, run_as uuid, last_run_at)
rule_runs(id bigint, rule_id, event_id, status, log jsonb, started_at, finished_at)
integrations(id pk → objects, kind text, config jsonb, secrets_enc bytea, status, last_sync_at)
webhooks(id, integration_id null, url, events text[], secret_enc, enabled)  webhook_deliveries(id bigint, webhook_id, event_id, status, response_code, attempts, next_at)
api_tokens(id, user_id, name, token_hash unique, scopes text[], expires_at, last_used_at)
embeddings(id bigint, object_id, chunk_no, text, embedding vector(1024), model, updated_at)  idx: hnsw(embedding vector_cosine_ops), (object_id)
```

## Индексация и производительность

- Партиционирование по месяцам: `audit_log`, `activities`, `notifications`, `query_runs`, `webhook_deliveries` (pg_partman или собственная ротация заданием).
- Все таблицы датасетов: `autovacuum` настроен агрессивнее для активно редактируемых; после импорта — `ANALYZE`.
- Для списков используется курсорная пагинация по `(sort_key, id)`.
- Счётчики (`row_count`, непрочитанные) — денормализованы и обновляются подписчиками событий, не `COUNT(*)` на лету.
- Кэши в Redis: `PrincipalSet`, результаты запросов, тайлы, сводки объектов (`ObjectSummary`), presence.

## Миграции

- Схема `public` — Drizzle Kit, миграции в `apps/api/drizzle/`, применяются при старте `api` с advisory lock.
- Схема `ds` — только код `physical.ts`; миграции на изменения системных столбцов датасетов — специальные задания обслуживания.
- Каждая миграция обратима или сопровождается планом отката; тест «миграция с нуля + миграция с последнего релиза» в CI.

## Резервирование данных

Единая точка правды упрощает резервирование: `pgBackRest` (полный еженедельно, инкрементальный ежедневно, WAL непрерывно; RPO 15 мин), версии и репликация бакетов MinIO, дамп Meilisearch (перестраиваемый из Postgres), Redis — только кэш и очереди (AOF для очередей). См. `15-admin-operations.md`.
