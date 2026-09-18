# API, события и realtime-протокол

Статус: **Решено** (ADR-0005).

## 1. Соглашения REST API

- База: `/api/v1`. JSON, UTF-8. Все маршруты типизированы zod-схемами в `packages/contracts`, из которых генерируются OpenAPI (`/api/openapi.json`) и типизированный клиент для внешних потребителей; веб-клиент использует те же zod-типы напрямую (ADR-0030).
- Ресурсы: множественное число, kebab-case: `/datasets/{id}/fields`, `/documents/{id}/versions`, `/gis/layers/{id}/tiles/{z}/{x}/{y}.pbf`. Универсальные: `/objects/{id}` (сводка, права, связи, активность), `/objects:batch-get`, `/search`, `/inbox`, `/notifications`, `/me`, `/me/workspace-state`.
- Действия, не укладывающиеся в CRUD: `POST /documents/{id}:submit`, `:approve`, `:register`, `POST /datasets/{id}:import`, `POST /queries:run`. Двоеточие — единый стиль для действий.
- Идентификаторы: UUID v7; строки датасетов — `bigint` в строке.
- Пагинация: курсорная (`?cursor=&limit=`), ответ `{items, nextCursor, total?}`; `total` — только по запросу `&count=true` (может быть приблизительным для датасетов, флаг `approx`).
- Фильтрация списков объектов: `?filter=<json>` в формате `FilterBuilder` (`contracts/field-types.md`), `?sort=field:asc,field2:desc`, `?fields=` (частичный ответ), `?include=owner,space` (расширение связей).
- Версии/конкурентность: ответы содержат `version`; изменяющие запросы принимают `If-Match: <version>` → `409` при конфликте.
- Идемпотентность: `Idempotency-Key` для `POST`, хранится 24 ч.
- Длительные операции: `202 Accepted` + `{jobId}`; статус `/jobs/{id}`; прогресс по WebSocket.
- Ошибки: `application/problem+json` (RFC 9457): `{type, title, status, detail, instance, code, errors?: [{path, message, code}]}`. Коды: `validation_failed`, `not_found`, `forbidden` (только если `view` есть, иначе `not_found`), `conflict`, `rate_limited`, `dependency_failed`, `query_timeout`, `policy_violation`.
- Локализация ошибок: `Accept-Language`; коды стабильны, тексты — по локали.
- Загрузка файлов: подписанные URL в S3 (не через API-тело, кроме мелких ≤ 5 МБ).
- Безопасность: cookie `kchs_session` (HttpOnly, Secure, SameSite=Lax) + CSRF-токен в заголовке для изменяющих запросов от браузера; Bearer-токены для интеграций; CORS только для доверенных origin.
- Гостевой доступ: `POST /share/{token}/open` (публичный, с паролем при необходимости) выдаёт токен доступа для заголовка `x-kchs-share-token`; действует только на один объект (ADR-0032).
- Действия «от имени» (замещение): заголовок `x-kchs-on-behalf-of: <userId>` принимается только в пределах активного делегирования; иначе `403` (ADR-0033).
- Версионирование: `v1` в пути; несовместимые изменения — `v2` с периодом сосуществования; добавления полей — совместимы.
- Ограничения: rate limit `429` с `Retry-After`; максимальный размер тела 10 МБ (кроме загрузок).

## 2. Каталог доменных событий

Формат имени: `<domain>.<entity>.<verb>` в прошедшем времени, версия в конверте. Полный список ведётся в `packages/contracts/events.ts` (zod-схемы полезной нагрузки). Ключевые:

| Домен | События |
|---|---|
| object | `object.created`, `object.updated` (changedFields), `object.moved`, `object.archived`, `object.restored`, `object.trashed`, `object.deleted`, `object.shared` (acl diff), `object.linked`, `object.unlinked`, `object.tagged` |
| identity | `user.created`, `user.updated`, `user.blocked`, `user.login`, `user.login_failed`, `user.logout`, `user.password_changed`, `user.mfa_enabled`, `user.mfa_disabled`, `org.unit_changed`, `org.employment_changed`, `delegation.started`, `delegation.ended`, `session.revoked` |
| space | `space.created`, `space.member_added`, `space.member_removed`, `space.member_role_changed` |
| discussion | `message.posted`, `message.edited`, `message.deleted`, `message.reacted`, `mention.created` |
| data | `source.checked`, `dataset.created`, `dataset.schema_changed`, `dataset.import_started`, `dataset.imported`, `dataset.import_failed`, `dataset.rows_changed` (ids, op), `dataset.version_created`, `query.executed`, `metric.evaluated`, `dashboard.published`, `report.generated`, `form.assigned`, `form.submitted`, `form.reviewed`, `alert.fired`, `quality.evaluated`, `pipeline.run_finished` |
| gis | `layer.published`, `layer.style_changed`, `feature.created`, `feature.updated`, `feature.deleted`, `feature.edit_submitted`, `feature.edit_reviewed`, `analysis.finished`, `territory.updated` |
| documents | `document.created`, `document.submitted`, `document.step_assigned`, `document.approved`, `document.rejected`, `document.returned`, `document.signed`, `document.registered`, `document.resolution_added`, `document.instruction_reported`, `document.executed`, `document.filed`, `document.archived`, `document.cancelled`, `document.ack_required`, `document.acknowledged`, `document.version_added` |
| files | `file.uploaded`, `file.version_added`, `file.previewed`, `file.text_extracted`, `file.shared_link_created`, `file.downloaded` (аудит) |
| tasks | `task.created`, `task.assigned`, `task.accepted`, `task.status_changed`, `task.due_changed`, `task.reported`, `task.completed`, `task.returned`, `task.extension_requested`, `task.overdue`, `task.due_soon`, `project.created` |
| meetings | `meeting.scheduled`, `meeting.started`, `meeting.participant_joined`, `meeting.ended`, `recording.ready`, `transcript.ready`, `protocol.drafted`, `protocol.confirmed`, `protocol.registered`, `call.incoming` |
| calendar | `event.created`, `event.updated`, `event.cancelled`, `event.invited`, `event.responded`, `event.reminder` |
| knowledge | `page.published`, `page.updated`, `page.review_due`, `page.ack_required`, `page.acknowledged` |
| process | `process.started`, `process.step_activated`, `process.step_completed`, `process.step_overdue`, `process.finished` |
| notifications | `notification.sent`, `inbox.opened`, `inbox.resolved`, `inbox.snoozed` |
| automation | `rule.triggered`, `rule.executed`, `rule.failed`, `webhook.received`, `webhook.delivered`, `integration.synced`, `integration.failed` |
| jobs | `job.queued`, `job.started`, `job.progress` (только realtime, не в outbox), `job.finished`, `job.failed` |
| admin | `settings.changed`, `acl.changed`, `role.assigned`, `backup.completed`, `backup.failed`, `announcement.published` |

Конверт события — `contracts/events.md`. Правило: событие описывает **факт**, а не намерение; полезная нагрузка содержит идентификаторы и минимальный снимок изменённых полей, не полные объекты.

## 3. Realtime-протокол (Socket.IO)

- Подключение: `/ws` с cookie-сессией; при неудаче — переподключение с экспоненциальной задержкой; после переподключения клиент повторно подписывается и запрашивает `since=<lastEventId>` для пропущенных `object.updated` по открытым вкладкам.
- Клиент → сервер: `subscribe {rooms: ['object:…','space:…','conversation:…','job:…']}`, `unsubscribe`, `presence.view {objectId}`, `typing {conversationId}`, `ping`.
- Сервер → клиент: `object.updated {id, type, version, changedFields, actorId}`, `object.removed {id}`, `message.posted {conversationId, message}`, `message.updated`, `notification.new {notification}`, `inbox.changed {counts}`, `job.progress {jobId, progress, message}`, `job.finished {jobId, status}`, `presence {objectId, users[]}`, `typing {...}`, `call.incoming {meetingId, from}`, `acl.revoked {objectId}` (клиент закрывает вкладку с сообщением).
- Комнаты объектов проверяются `authorize(view)` при подписке; изменение ACL → пересчёт членов комнаты.
- Совместное редактирование — `/collab` (Hocuspocus, Yjs); имя документа = `objectId`, аутентификация токеном сессии, права `edit`/`view` (read-only режим).

## 4. Внутренние контракты между модулями (`public.ts`)

Примеры (исполнитель фиксирует сигнатуры в коде):
- `tasks.public.createInstruction({source, authorId, assigneeId, coAssignees, dueAt|dueWorkingDays, controllerId, title, text})`, `tasks.public.getStatusSummary(sourceObjectId)`.
- `documents.public.createFromReport({reportRunId, typeId, subject, fileId})`, `documents.public.registerProtocol({protocolId, typeId})`.
- `data.public.runQuery(ctx, spec, opts)`, `data.public.getDatasetSchema(id)`, `data.public.upsertRows(ctx, datasetId, rows, opts)`, `data.public.evaluateMetric(ctx, metricId, dims, period)`.
- `gis.public.assignTerritory(points)`, `gis.public.getTerritoryTree()`, `gis.public.renderMapSnapshot(mapId, view)`.
- `files.public.createFromBuffer/Stream(...)`, `files.public.getSignedUrl(fileId, versionId?)`, `files.public.extractText(fileId)`.
- `comms.public.postSystemMessage(objectId, template, params)`, `meetings.public.createRoom(...)`.
- `ai.public.complete(task, input, schema)`, `ai.public.embed(texts)`.

Правило: публичный API принимает `ctx: UserCtx | SystemCtx`, не «доверяет» вызывающему и сам проверяет права.
