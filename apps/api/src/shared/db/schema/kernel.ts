import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, type LangTextValue, tsCol, updatedAt } from './_shared.js'
import { users } from './identity.js'

// ─── Реестр объектов ─────────────────────────────────────────────────────────

/**
 * Каждая значимая сущность продукта — строка в `objects` (02-platform-kernel.md §1).
 * Таблица модуля разделяет с ней тот же UUID.
 */
export const objects = pgTable(
  'objects',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    spaceId: uuid('space_id'),
    parentId: uuid('parent_id'),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    icon: text('icon'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: tsCol('archived_at'),
    deletedAt: tsCol('deleted_at'),
    accessMode: text('access_mode').notNull().default('inherit'),
    /** Лёгкие сводные поля для карточек и списков (статус, срок, исполнитель). */
    meta: jsonbObject('meta'),
    searchVersion: bigint('search_version', { mode: 'number' }).notNull().default(0),
    version: integer('version').notNull().default(1),
    /**
     * Гриф объекта (ADR-0080): атрибутное ограничение ядра — выше допуска
     * пользователя объект недоступен независимо от прав. Задаёт модуль типа.
     */
    confidentiality: text('confidentiality').notNull().default('public'),
  },
  (t) => [
    index('objects_space_type_idx').on(t.spaceId, t.type, t.deletedAt),
    index('objects_confidential_idx')
      .on(t.confidentiality)
      .where(sql`${t.confidentiality} <> 'public'`),
    check(
      'objects_confidentiality_check',
      sql`${t.confidentiality} in ('public', 'internal', 'confidential')`,
    ),
    index('objects_parent_idx').on(t.parentId),
    index('objects_owner_idx').on(t.ownerId),
    index('objects_type_updated_idx').on(t.type, t.updatedAt.desc()),
    index('objects_meta_idx').using('gin', sql`${t.meta} jsonb_path_ops`),
    index('objects_title_trgm').using('gin', sql`${t.title} extensions.gin_trgm_ops`),
  ],
)

/** Замыкание дерева объектов: наследование прав и быстрые выборки поддерева. */
export const objectAncestors = pgTable(
  'object_ancestors',
  {
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    ancestorId: uuid('ancestor_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.objectId, t.ancestorId] }),
    index('object_ancestors_ancestor_idx').on(t.ancestorId),
  ],
)

// ─── Пространства ────────────────────────────────────────────────────────────

export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    key: text('key').notNull().unique(),
    kind: text('kind').notNull(),
    unitId: uuid('unit_id'),
    description: text('description'),
    settings: jsonbObject('settings'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('spaces_kind_idx').on(t.kind), index('spaces_unit_idx').on(t.unitId)],
)

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    addedBy: uuid('added_by'),
    addedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index('space_members_user_idx').on(t.userId),
  ],
)

// ─── Доступ ──────────────────────────────────────────────────────────────────

export const aclEntries = pgTable(
  'acl_entries',
  {
    id: uuid('id').primaryKey(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    /** none=0 … owner=5 (03-access-model.md). */
    level: smallint('level').notNull(),
    grantedBy: uuid('granted_by'),
    grantedAt: createdAt(),
    expiresAt: tsCol('expires_at'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('acl_entries_object_principal_key').on(t.objectId, t.principalType, t.principalId),
    index('acl_entries_principal_idx').on(t.principalType, t.principalId),
  ],
)

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    level: smallint('level').notNull().default(1),
    passwordHash: text('password_hash'),
    expiresAt: tsCol('expires_at'),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    includeAttachments: boolean('include_attachments').notNull().default(false),
    revokedAt: tsCol('revoked_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('share_links_object_idx').on(t.objectId)],
)

// ─── Связи и зависимости ─────────────────────────────────────────────────────

export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('related'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    meta: jsonbObject('meta'),
  },
  (t) => [
    uniqueIndex('links_source_target_kind_key').on(t.sourceId, t.targetId, t.kind),
    index('links_target_idx').on(t.targetId),
  ],
)

export const dependencies = pgTable(
  'dependencies',
  {
    fromId: uuid('from_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    toId: uuid('to_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('uses'),
  },
  (t) => [
    primaryKey({ columns: [t.fromId, t.toId, t.kind] }),
    index('dependencies_to_idx').on(t.toId),
  ],
)

// ─── Теги, избранное, недавние, подписки ─────────────────────────────────────

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey(),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tags_space_name_key').on(
      sql`coalesce(${t.spaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
  ],
)

export const objectTags = pgTable(
  'object_tags',
  {
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.objectId, t.tagId] }), index('object_tags_tag_idx').on(t.tagId)],
)

export const favorites = pgTable(
  'favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    sort: doublePrecision('sort').notNull().default(0),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.objectId] })],
)

export const recentViews = pgTable(
  'recent_views',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    viewedAt: tsCol('viewed_at').notNull().default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.objectId] }),
    index('recent_views_user_time_idx').on(t.userId, t.viewedAt.desc()),
  ],
)

export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('all'),
    source: text('source').notNull().default('manual'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.objectId] }),
    index('subscriptions_object_idx').on(t.objectId),
  ],
)

// ─── Обсуждения (единые с чатами) ────────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Обсуждение объекта: ровно одна беседа на объект. */
    objectId: uuid('object_id')
      .unique()
      .references(() => objects.id, { onDelete: 'cascade' }),
    privacy: text('privacy').notNull().default('closed'),
    lastMessageAt: tsCol('last_message_at'),
    messageCount: integer('message_count').notNull().default(0),
    settings: jsonbObject('settings'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversations_kind_idx').on(t.kind, t.lastMessageAt.desc())],
)

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number' }),
    mutedUntil: tsCol('muted_until'),
    pinned: boolean('pinned').notNull().default(false),
    /** Убрана участником в архив (ADR-0161); у каждого участника — свой. */
    archivedAt: tsCol('archived_at'),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('conversation_members_user_idx').on(t.userId),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    onBehalfOf: uuid('on_behalf_of'),
    kind: text('kind').notNull().default('user'),
    /** Tiptap JSON. */
    body: jsonb('body').$type<Record<string, unknown> | null>(),
    text: text('text').notNull().default(''),
    /** Для системных сообщений: ключ i18n и параметры. */
    systemKey: text('system_key'),
    systemParams: jsonb('system_params').$type<Record<string, unknown> | null>(),
    replyToId: bigint('reply_to_id', { mode: 'number' }),
    threadRootId: bigint('thread_root_id', { mode: 'number' }),
    threadReplyCount: integer('thread_reply_count').notNull().default(0),
    threadLastReplyAt: tsCol('thread_last_reply_at'),
    attachments: jsonb('attachments')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    mentions: uuid('mentions').array().notNull().default(sql`'{}'::uuid[]`),
    mentionedObjectIds: uuid('mentioned_object_ids').array().notNull().default(sql`'{}'::uuid[]`),
    editedAt: tsCol('edited_at'),
    deletedAt: tsCol('deleted_at'),
    createdAt: createdAt(),
    meta: jsonbObject('meta'),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.id.desc()),
    index('messages_thread_idx').on(t.threadRootId),
    index('messages_mentions_idx').using('gin', t.mentions),
    index('messages_text_trgm').using('gin', sql`${t.text} extensions.gin_trgm_ops`),
  ],
)

export const reactions = pgTable(
  'reactions',
  {
    messageId: bigint('message_id', { mode: 'number' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
)

// ─── Активность и аудит ──────────────────────────────────────────────────────

export const activities = pgTable(
  'activities',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    eventId: text('event_id'),
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id'),
    actorId: uuid('actor_id'),
    onBehalfOf: uuid('on_behalf_of'),
    verb: text('verb').notNull(),
    summary: jsonbObject<{ key: string; params: Record<string, unknown> }>('summary'),
    occurredAt: tsCol('occurred_at').notNull().default(sql`now()`),
  },
  (t) => [
    index('activities_object_idx').on(t.objectId, t.id.desc()),
    index('activities_actor_idx').on(t.actorId, t.id.desc()),
    index('activities_occurred_idx').on(t.occurredAt.desc()),
  ],
)

/**
 * Неизменяемый журнал безопасности. Партиционирован по месяцам;
 * роль kchs_app имеет только INSERT/SELECT (миграция 0001_hardening).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    occurredAt: tsCol('occurred_at').notNull().default(sql`now()`),
    actorId: uuid('actor_id'),
    onBehalfOf: uuid('on_behalf_of'),
    action: text('action').notNull(),
    objectId: uuid('object_id'),
    objectType: text('object_type'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    details: jsonbObject('details'),
    severity: text('severity').notNull().default('info'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('audit_log_actor_idx').on(t.actorId, t.occurredAt.desc()),
    index('audit_log_object_idx').on(t.objectId, t.occurredAt.desc()),
    index('audit_log_action_idx').on(t.action, t.occurredAt.desc()),
  ],
)

// ─── Уведомления и Входящие ──────────────────────────────────────────────────

export const notifications = pgTable(
  'notifications',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text('event_id'),
    category: text('category').notNull(),
    /** Ключ i18n и параметры вместо готового текста — уведомление локализуется при выдаче. */
    titleKey: text('title_key').notNull(),
    params: jsonbObject('params'),
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    url: text('url'),
    channels: jsonb('channels').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Ключ агрегации: несколько событий одного объекта за окно сливаются. */
    aggregateKey: text('aggregate_key'),
    aggregateCount: integer('aggregate_count').notNull().default(1),
    readAt: tsCol('read_at'),
    /** Когда уведомление ушло на почту (немедленно или в дайджесте). */
    emailedAt: tsCol('emailed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.id.desc()),
    index('notifications_unread_idx').on(t.userId, t.readAt),
    index('notifications_aggregate_idx').on(t.userId, t.aggregateKey),
  ],
)

export const inboxItems = pgTable(
  'inbox_items',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
    processStepId: uuid('process_step_id'),
    titleKey: text('title_key').notNull(),
    params: jsonbObject('params'),
    actorId: uuid('actor_id'),
    /** Элемент продублирован заместителю: чьи это Входящие на самом деле. */
    onBehalfOf: uuid('on_behalf_of'),
    dueAt: tsCol('due_at'),
    priority: text('priority').notNull().default('normal'),
    state: text('state').notNull().default('open'),
    openedAt: createdAt(),
    resolvedAt: tsCol('resolved_at'),
    resolution: text('resolution'),
    snoozedUntil: tsCol('snoozed_until'),
    /** Ключ идемпотентности: (kind, object, user) не дублируется. */
    dedupeKey: text('dedupe_key'),
    payload: jsonbObject('payload'),
  },
  (t) => [
    index('inbox_items_user_idx').on(t.userId, t.state, t.dueAt),
    index('inbox_items_object_idx').on(t.objectId, t.kind),
    uniqueIndex('inbox_items_dedupe_key')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.state} in ('open','snoozed')`),
  ],
)

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    channel: text('channel').notNull(),
    mode: text('mode').notNull().default('immediate'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category, t.channel] })],
)

// ─── Задания ─────────────────────────────────────────────────────────────────

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    name: text('name').notNull(),
    objectId: uuid('object_id'),
    initiatorId: uuid('initiator_id'),
    status: text('status').notNull().default('queued'),
    progress: doublePrecision('progress').notNull().default(0),
    message: text('message'),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: jsonb('error').$type<Record<string, unknown> | null>(),
    attempts: integer('attempts').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    /** Входные данные задания: хранятся до передачи в очередь после коммита. */
    payload: jsonbObject('payload'),
    /** Параметры BullMQ (задержка, число попыток). */
    options: jsonbObject('options'),
    createdAt: createdAt(),
    startedAt: tsCol('started_at'),
    finishedAt: tsCol('finished_at'),
  },
  (t) => [
    index('jobs_status_idx').on(t.status, t.createdAt.desc()),
    index('jobs_object_idx').on(t.objectId),
    index('jobs_initiator_idx').on(t.initiatorId, t.createdAt.desc()),
    uniqueIndex('jobs_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
)

// ─── Процессы ────────────────────────────────────────────────────────────────

/**
 * Определения маршрутов с версиями (ADR-0079): опубликованная версия
 * неизменна, черновик (`published_at is null`) у ключа один — следующий номер.
 */
export const processDefinitions = pgTable(
  'process_definitions',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    version: integer('version').notNull().default(1),
    objectType: text('object_type').notNull(),
    definition: jsonbObject('definition'),
    publishedAt: tsCol('published_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('process_definitions_key_version_key').on(t.key, t.version),
    uniqueIndex('process_definitions_draft_key').on(t.key).where(sql`${t.publishedAt} is null`),
  ],
)

/**
 * Экземпляр маршрута объекта: закреплён за версией определения; в `context` —
 * переменные, выбор инициатора, применённые условия, круг и счётчик шагов.
 */
export const processInstances = pgTable(
  'process_instances',
  {
    id: uuid('id').primaryKey(),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => processDefinitions.id),
    definitionKey: text('definition_key').notNull(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    context: jsonbObject('context'),
    startedBy: uuid('started_by'),
    startedAt: createdAt(),
    finishedAt: tsCol('finished_at'),
    outcome: text('outcome'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('process_instances_object_idx').on(t.objectId),
    index('process_instances_status_idx').on(t.status),
    // Один идущий экземпляр маршрута на объект
    uniqueIndex('process_instances_running_key')
      .on(t.objectId, t.definitionKey)
      .where(sql`${t.status} = 'running'`),
  ],
)

/**
 * Активация шага: назначенные и их решения (`assignees`), срок, таймеры
 * (`timers` и ближайший `next_timer_at` — состояние только в базе), итог.
 */
export const processSteps = pgTable(
  'process_steps',
  {
    id: uuid('id').primaryKey(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => processInstances.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('active'),
    assignees: jsonb('assignees')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Назначенные определены (у шага решения без назначенных — ждёт переназначения). */
    resolved: boolean('resolved').notNull().default(false),
    dueAt: tsCol('due_at'),
    startedAt: tsCol('started_at'),
    completedAt: tsCol('completed_at'),
    outcome: text('outcome'),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    sequence: integer('sequence').notNull().default(0),
    /** Круг согласования: растёт при повторной отправке после возврата. */
    round: integer('round').notNull().default(1),
    /** Параллельный шаг и номер ветви, в которой идёт шаг. */
    parentId: uuid('parent_id'),
    branch: integer('branch'),
    /** Шаг, после которого активирован этот (`previous_step.assignees`). */
    prevId: uuid('prev_id'),
    timers: jsonbObject('timers'),
    nextTimerAt: tsCol('next_timer_at'),
    /** Ожидаемое событие шага `wait`. */
    waitEvent: text('wait_event'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('process_steps_instance_idx').on(t.instanceId, t.sequence),
    index('process_steps_timer_idx')
      .on(t.nextTimerAt)
      .where(sql`${t.status} = 'active' and ${t.nextTimerAt} is not null`),
    index('process_steps_wait_idx')
      .on(t.waitEvent)
      .where(sql`${t.status} = 'active' and ${t.waitEvent} is not null`),
    // Участники шагов: производное право видеть объект (политика типа)
    index('process_steps_assignees_idx').using('gin', sql`${t.assignees} jsonb_path_ops`),
  ],
)

export const processStepActions = pgTable(
  'process_step_actions',
  {
    id: uuid('id').primaryKey(),
    stepId: uuid('step_id')
      .notNull()
      .references(() => processSteps.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    onBehalfOf: uuid('on_behalf_of'),
    action: text('action').notNull(),
    comment: text('comment'),
    payload: jsonbObject('payload'),
    at: tsCol('at').notNull().default(sql`now()`),
  },
  (t) => [index('process_step_actions_step_idx').on(t.stepId)],
)

// ─── Представления, настройки, календарь ─────────────────────────────────────

export const views = pgTable(
  'views',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    objectType: text('object_type').notNull(),
    definition: jsonbObject('definition'),
    shared: boolean('shared').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('views_object_type_idx').on(t.objectType)],
)

export const settings = pgTable(
  'settings',
  {
    /** system | space | user */
    scope: text('scope').notNull(),
    scopeId: uuid('scope_id'),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settings_pk').on(
      t.scope,
      sql`coalesce(${t.scopeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.key,
    ),
  ],
)

export const businessCalendar = pgTable(
  'business_calendar',
  {
    country: text('country').notNull(),
    day: date('day').notNull(),
    /** work | weekend | holiday | short */
    kind: text('kind').notNull(),
    note: jsonb('note').$type<LangTextValue | null>(),
  },
  (t) => [primaryKey({ columns: [t.country, t.day] })],
)

export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    severity: text('severity').notNull().default('info'),
    startsAt: tsCol('starts_at').notNull().default(sql`now()`),
    endsAt: tsCol('ends_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('announcements_active_idx').on(t.startsAt, t.endsAt)],
)

// ─── Ознакомление ────────────────────────────────────────────────────────────

/**
 * Запрос ознакомления с объектом (08-documents.md §10, ADR-0084): вручную из
 * карточки, правилом типа при регистрации или шагом маршрута `acknowledge`
 * (тогда `process_step_id` — активация шага). Общий для документов и страниц.
 */
export const acknowledgmentRequests = pgTable(
  'acknowledgment_requests',
  {
    id: uuid('id').primaryKey(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** manual | register | process */
    source: text('source').notNull(),
    processStepId: uuid('process_step_id'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedAt: tsCol('requested_at').notNull().default(sql`now()`),
    dueAt: tsCol('due_at'),
    requireSecondFactor: boolean('require_second_factor').notNull().default(false),
    note: text('note'),
    cancelledAt: tsCol('cancelled_at'),
  },
  (t) => [
    index('acknowledgment_requests_object_idx').on(t.objectId, t.requestedAt),
    uniqueIndex('acknowledgment_requests_step_uq')
      .on(t.processStepId)
      .where(sql`${t.processStepId} is not null`),
  ],
)

/**
 * Ознакомление сотрудника по запросу (05-data-model.md: `acknowledgments`):
 * ждёт — пока нет ни отметки, ни снятия; отметка — время, кто нажал
 * (заместитель) и подтверждение вторым фактором.
 */
export const acknowledgments = pgTable(
  'acknowledgments',
  {
    id: uuid('id').primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => acknowledgmentRequests.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    requiredAt: tsCol('required_at').notNull().default(sql`now()`),
    dueAt: tsCol('due_at'),
    acknowledgedAt: tsCol('acknowledged_at'),
    /** Кто отметил, если не сам сотрудник (заместитель). */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    secondFactor: boolean('second_factor').notNull().default(false),
    cancelledAt: tsCol('cancelled_at'),
    remindedAt: tsCol('reminded_at'),
    reminders: integer('reminders').notNull().default(0),
  },
  (t) => [
    uniqueIndex('acknowledgments_request_user_uq').on(t.requestId, t.userId),
    index('acknowledgments_object_user_idx').on(t.objectId, t.userId),
    index('acknowledgments_pending_idx')
      .on(t.userId, t.dueAt)
      .where(sql`${t.acknowledgedAt} is null and ${t.cancelledAt} is null`),
  ],
)

export type ObjectRow = typeof objects.$inferSelect
export type ObjectInsert = typeof objects.$inferInsert
export type SpaceRow = typeof spaces.$inferSelect
export type AclEntryRow = typeof aclEntries.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type InboxItemRow = typeof inboxItems.$inferSelect
