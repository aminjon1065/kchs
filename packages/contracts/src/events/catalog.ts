import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Каталог доменных событий (16-api-and-events.md §2).
 * Регистрация типа события без схемы полезной нагрузки запрещена — проверяется тестом.
 * Здесь — события, появляющиеся в фазе 0; модули расширяют каталог своими схемами.
 */
const empty = z.object({})

export const EVENT_PAYLOADS = {
  // ── object ────────────────────────────────────────────────────────────────
  'object.created': z.object({ type: z.string(), title: z.string() }),
  'object.updated': z.object({ title: z.string().optional() }),
  'object.moved': z.object({
    fromParentId: Uuid.nullable(),
    toParentId: Uuid.nullable(),
    fromSpaceId: Uuid.nullable(),
    toSpaceId: Uuid.nullable(),
  }),
  'object.archived': empty,
  'object.restored': z.object({ from: z.enum(['archive', 'trash']) }),
  'object.trashed': empty,
  'object.deleted': z.object({ type: z.string() }),
  'object.shared': z.object({
    added: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    removed: z.array(z.object({ principal: z.string() })).default([]),
    changed: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    accessMode: z.string().optional(),
    /** Права — следствие другого действия (участник поручения): без уведомления. */
    quiet: z.boolean().optional(),
  }),
  'object.linked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.unlinked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.tagged': z.object({ tagIds: z.array(Uuid) }),

  // ── identity ──────────────────────────────────────────────────────────────
  'user.created': z.object({ login: z.string() }),
  'user.updated': empty,
  'user.blocked': z.object({ reason: z.string().nullable().default(null) }),
  'user.login': z.object({ ip: z.string().nullable(), userAgent: z.string().nullable() }),
  'user.login_failed': z.object({ login: z.string(), reason: z.string() }),
  'user.logout': empty,
  'user.password_changed': empty,
  'user.mfa_enabled': z.object({ kind: z.string() }),
  'user.mfa_disabled': z.object({ kind: z.string() }),
  'user.roles_changed': z.object({ userId: Uuid, roles: z.array(z.string()) }),
  /** Telegram привязан к пользователю (ADR-0061); chat_id в событие не попадает. */
  'user.telegram_linked': z.object({ userId: Uuid }),
  /** Привязка снята: самим пользователем или потому что бот заблокирован. */
  'user.telegram_unlinked': z.object({ userId: Uuid, reason: z.enum(['user', 'blocked']) }),
  'org.unit_changed': z.object({ unitId: Uuid, change: z.string() }),
  'org.employment_changed': z.object({ userId: Uuid, unitId: Uuid.nullable() }),
  'delegation.started': z.object({ fromUserId: Uuid, toUserId: Uuid, scope: z.string() }),
  'delegation.ended': z.object({ fromUserId: Uuid, toUserId: Uuid }),
  'session.revoked': z.object({ sessionIds: z.array(Uuid) }),

  // ── space ─────────────────────────────────────────────────────────────────
  'space.created': z.object({ key: z.string(), kind: z.string() }),
  'space.member_added': z.object({ userId: Uuid, role: z.string() }),
  'space.member_removed': z.object({ userId: Uuid }),
  'space.member_role_changed': z.object({ userId: Uuid, role: z.string(), from: z.string() }),

  // ── discussion ────────────────────────────────────────────────────────────
  'message.posted': z.object({
    conversationId: Uuid,
    messageId: z.string(),
    preview: z.string(),
    threadRootId: z.string().nullable().default(null),
    mentions: z.array(Uuid).default([]),
  }),
  'message.edited': z.object({ conversationId: Uuid, messageId: z.string() }),
  'message.deleted': z.object({ conversationId: Uuid, messageId: z.string() }),
  'message.reacted': z.object({ conversationId: Uuid, messageId: z.string(), emoji: z.string() }),
  'mention.created': z.object({
    conversationId: Uuid,
    messageId: z.string(),
    userIds: z.array(Uuid),
  }),

  // ── files ─────────────────────────────────────────────────────────────────
  'file.uploaded': z.object({ name: z.string(), size: z.number(), mime: z.string() }),
  'file.version_added': z.object({ versionId: Uuid, number: z.number().int() }),
  'file.text_extracted': z.object({ chars: z.number().int() }),
  'file.previewed': z.object({ status: z.string() }),
  'file.shared_link_created': z.object({ linkId: Uuid }),
  'file.downloaded': z.object({ versionId: Uuid.nullable() }),

  // ── notifications ─────────────────────────────────────────────────────────
  'notification.sent': z.object({
    userId: Uuid,
    category: z.string(),
    channels: z.array(z.string()),
  }),
  'inbox.opened': z.object({ userId: Uuid, kind: z.string(), itemId: Uuid }),
  'inbox.resolved': z.object({ userId: Uuid, itemId: Uuid, outcome: z.string() }),
  'inbox.snoozed': z.object({ userId: Uuid, itemId: Uuid, until: z.string() }),

  // ── jobs ──────────────────────────────────────────────────────────────────
  'job.queued': z.object({ jobId: Uuid, queue: z.string(), name: z.string() }),
  'job.started': z.object({ jobId: Uuid }),
  'job.finished': z.object({ jobId: Uuid, durationMs: z.number().int() }),
  'job.failed': z.object({ jobId: Uuid, error: z.string() }),

  // ── dataset (06-analytics-engine.md) ──────────────────────────────────────
  'dataset.created': z.object({ name: z.string(), fields: z.number().int() }),
  'dataset.schema_changed': z.object({
    change: z.enum(['added', 'updated', 'removed', 'type_changed']),
    fields: z.array(z.string()),
  }),
  'dataset.import_started': z.object({ importId: Uuid, mode: z.string() }),
  'dataset.imported': z.object({
    importId: Uuid,
    version: z.number().int(),
    mode: z.string(),
    rows: z.number().int(),
    inserted: z.number().int(),
    updated: z.number().int(),
    deleted: z.number().int(),
    errors: z.number().int(),
  }),
  'dataset.import_failed': z.object({ importId: Uuid, reason: z.string() }),
  /** Сводка изменений готова, импорт ждёт публикации (ADR-0068). */
  'dataset.import_review': z.object({
    importId: Uuid,
    added: z.number().int(),
    changed: z.number().int(),
    deleted: z.number().int(),
  }),
  'dataset.import_published': z.object({ importId: Uuid }),
  'dataset.import_cancelled': z.object({ importId: Uuid }),
  'dataset.rows_changed': z.object({
    op: z.enum(['insert', 'update', 'delete']),
    ids: z.array(z.string()).max(1000),
    count: z.number().int(),
  }),
  'dataset.version_created': z.object({ version: z.number().int(), origin: z.string() }),
  'dataset.rolled_back': z.object({
    version: z.number().int(),
    target: z.number().int(),
    from: z.number().int(),
  }),
  'dataset.policies_changed': z.object({
    kind: z.enum(['rows', 'columns']),
    op: z.enum(['created', 'updated', 'deleted']),
    policyId: Uuid,
  }),
  'chart.updated': z.object({ changed: z.array(z.string()) }),
  'dashboard.updated': z.object({ changed: z.array(z.string()) }),
  'metric.updated': z.object({ changed: z.array(z.string()) }),
  /** Снимок тетради после совместной правки (ADR-0070): что изменилось — ячейки, параметры. */
  'notebook.updated': z.object({ changed: z.array(z.enum(['cells', 'params'])) }),

  // ── gis: базовые карты (07-gis-engine.md §5, ADR-0066) ─────────────────────
  /** Изменились параметры подложки: адрес, ключ, масштабы, сборка (новая версия PMTiles). */
  'basemap.updated': z.object({ changed: z.array(z.string()) }),
  /** Подложка по умолчанию установки сменилась. */
  'basemap.default_changed': z.object({ previousId: Uuid.nullable() }),

  // ── tasks (10-tasks-projects.md, ADR-0060) ─────────────────────────────────
  'task.created': z.object({ key: z.string(), kind: z.string(), assigneeId: Uuid.nullable() }),
  'task.assigned': z.object({
    key: z.string(),
    assigneeId: Uuid,
    previousAssigneeId: Uuid.nullable(),
  }),
  /** Исполнитель принял поручение к исполнению. */
  'task.accepted': z.object({ key: z.string() }),
  'task.status_changed': z.object({
    key: z.string(),
    kind: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  'task.due_changed': z.object({
    key: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  'task.reported': z.object({ key: z.string() }),
  /** Автор или контролёр принял отчёт — поручение закрыто. */
  'task.completed': z.object({ key: z.string() }),
  'task.returned': z.object({ key: z.string(), comment: z.string() }),
  'project.created': z.object({ key: z.string(), name: z.string() }),

  // ── gis (07-gis-engine.md, ADR-0064) ───────────────────────────────────────
  'layer.published': z.object({
    datasetId: Uuid,
    geometryType: z.enum(['point', 'line', 'polygon', 'mixed']),
  }),
  /** Стиль, поля тайла или режим правки слоя: версия слоя сменилась — тайлы заново. */
  'layer.style_changed': z.object({ changed: z.array(z.string()) }),
  'map.updated': z.object({ changed: z.array(z.string()) }),

  // ── gis: правка объектов (07-gis-engine.md §7, ADR-0076) ───────────────────
  // Объект события — слой; строка датасета — rowId, принятая правка — editId
  'feature.created': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
  }),
  /** fields — изменённые поля (геометрия — ключом своего поля). */
  'feature.updated': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
    fields: z.array(z.string()),
  }),
  'feature.deleted': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
  }),
  /** Правка модерируемого слоя ждёт проверки. */
  'feature.edit_submitted': z.object({
    editId: z.string(),
    op: z.enum(['create', 'update', 'delete']),
    datasetId: Uuid,
    rowId: z.string().nullable(),
    authorId: Uuid.nullable(),
  }),
  /** Решение по правке: принята (применена строкой датасета) или отклонена. */
  'feature.edit_reviewed': z.object({
    editId: z.string(),
    op: z.enum(['create', 'update', 'delete']),
    decision: z.enum(['approved', 'rejected']),
    datasetId: Uuid,
    rowId: z.string().nullable(),
    authorId: Uuid.nullable(),
  }),

  // ── territories (07-gis-engine.md §11, ADR-0067) ──────────────────────────
  /** Граница единицы справочника изменилась: changedFields — geom, centroid, areaKm2. */
  'territory.updated': z.object({ code: z.string() }),

  // ── gis: пространственный анализ (07-gis-engine.md §10, ADR-0069) ──────────
  'analysis.created': z.object({ kind: z.string(), datasetIds: z.array(Uuid) }),
  /** Запуск поставлен в очередь (создание с запуском или перезапуск). */
  'analysis.queued': z.object({ jobId: Uuid }),
  'analysis.started': z.object({ jobId: Uuid }),
  'analysis.finished': z.object({
    jobId: Uuid,
    status: z.enum(['succeeded', 'failed']),
    datasetId: Uuid.nullable(),
    rows: z.number().int().nullable(),
    error: z.string().nullable(),
  }),

  // ── admin ─────────────────────────────────────────────────────────────────
  'settings.changed': z.object({ scope: z.string(), key: z.string() }),
  'acl.changed': z.object({ objectId: Uuid }),
  'role.assigned': z.object({ userId: Uuid, roleKey: z.string() }),
  'announcement.published': z.object({ title: z.string() }),
  'announcement.withdrawn': z.object({ title: z.string() }),
} as const satisfies Record<string, z.ZodType>

export type EventType = keyof typeof EVENT_PAYLOADS
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[]

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>

export function isKnownEventType(type: string): type is EventType {
  return type in EVENT_PAYLOADS
}
