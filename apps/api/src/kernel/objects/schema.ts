import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from '../../shared/db/columns.js'
import { users } from '../directory/schema.js'

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

export type ObjectRow = typeof objects.$inferSelect

export type ObjectInsert = typeof objects.$inferInsert
