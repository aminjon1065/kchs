import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, tsCol, updatedAt } from './_shared.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/** Файл — объект реестра (09-files.md §2). */
export const files = pgTable(
  'files',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => objects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    storageKey: text('storage_key').notNull(),
    checksum: text('checksum'),
    currentVersionId: uuid('current_version_id'),
    versionNumber: integer('version_number').notNull().default(1),
    previewStatus: text('preview_status').notNull().default('none'),
    textStatus: text('text_status').notNull().default('none'),
    lockedBy: uuid('locked_by').references(() => users.id, { onDelete: 'set null' }),
    lockedAt: tsCol('locked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('files_folder_idx').on(t.folderId), index('files_checksum_idx').on(t.checksum)],
)

export const fileVersions = pgTable(
  'file_versions',
  {
    id: uuid('id').primaryKey(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    storageKey: text('storage_key').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    checksum: text('checksum'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    note: text('note'),
  },
  (t) => [index('file_versions_file_idx').on(t.fileId, t.number)],
)

export const fileTexts = pgTable('file_texts', {
  fileId: uuid('file_id')
    .primaryKey()
    .references(() => files.id, { onDelete: 'cascade' }),
  text: text('text').notNull().default(''),
  lang: text('lang'),
  pages: integer('pages'),
  extractedAt: tsCol('extracted_at').notNull().default(sql`now()`),
})

/** Превью страниц/миниатюр, сформированные движком. */
export const filePreviews = pgTable(
  'file_previews',
  {
    id: uuid('id').primaryKey(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** Версия, из которой построено превью: при новой версии старые заменяются. */
    versionId: uuid('version_id'),
    kind: text('kind').notNull(),
    page: integer('page'),
    storageKey: text('storage_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    mime: text('mime').notNull().default('image/webp'),
    createdAt: createdAt(),
  },
  (t) => [index('file_previews_file_idx').on(t.fileId, t.kind, t.page)],
)

/** Публичные ссылки на файл — отдельно от общих гостевых ссылок объекта. */
export const fileShares = pgTable(
  'file_shares',
  {
    id: uuid('id').primaryKey(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    passwordHash: text('password_hash'),
    expiresAt: tsCol('expires_at'),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    watermark: boolean('watermark').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('file_shares_file_idx').on(t.fileId)],
)

/** Незавершённые сессии загрузки в S3. */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id').notNull(),
    folderId: uuid('folder_id'),
    fileId: uuid('file_id'),
    /** Идентификаторы, выданные клиенту при создании сессии: они же в ключе хранения. */
    plannedFileId: uuid('planned_file_id'),
    plannedVersionId: uuid('planned_version_id'),
    attachToObjectId: uuid('attach_to_object_id'),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    multipartUploadId: text('multipart_upload_id'),
    parts: jsonb('parts')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('open'),
    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('upload_sessions_user_idx').on(t.userId, t.status)],
)

export type FileRow = typeof files.$inferSelect
export type FileVersionRow = typeof fileVersions.$inferSelect
