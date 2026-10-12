import { sql } from 'drizzle-orm'
import { type AnyPgColumn, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from '../../kernel/directory/schema.js'
import { objects } from '../../kernel/objects/schema.js'
import { createdAt, jsonbArray, jsonbObject, tsCol, updatedAt } from '../../shared/db/columns.js'

/**
 * Предупреждения Комитета в формате CAP 1.2 (ADR-0202). Предупреждение — объект
 * реестра (`objects.type = 'warning'`): права, поиск, связи и обсуждение — как у
 * всех объектов. Здесь — содержание одного `alert` CAP: блоки `info` по языкам,
 * области, ссылка на прежнее предупреждение и на сообщение-источник.
 */
export const warnings = pgTable(
  'warnings',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Идентификатор CAP (`urn:uuid:<id>`): уникален у отправителя навсегда. */
    identifier: text('identifier').notNull(),
    /** draft | on_approval | approved | published | updated | cancelled. */
    status: text('status').notNull().default('draft'),
    /** Alert | Update | Cancel. */
    msgType: text('msg_type').notNull().default('Alert'),
    /** Статус CAP: Actual | Exercise | Test. */
    capStatus: text('cap_status').notNull().default('Actual'),
    /** Прежнее предупреждение у уточнения и отмены (`references` CAP). */
    referencesId: uuid('references_id').references((): AnyPgColumn => warnings.id, {
      onDelete: 'set null',
    }),
    /** Чем уточнено или отменено опубликованное. */
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => warnings.id, {
      onDelete: 'set null',
    }),
    /** Блоки `info` по языкам: `{ tg: {event, headline, description, instruction}, ru, en }`. */
    info: jsonbObject('info'),
    categories: jsonbArray<string>('categories'),
    urgency: text('urgency').notNull().default('Expected'),
    severity: text('severity').notNull().default('Moderate'),
    certainty: text('certainty').notNull().default('Likely'),
    responseTypes: jsonbArray<string>('response_types'),
    effective: tsCol('effective'),
    expires: tsCol('expires'),
    /** Области: `[{ territoryId, description, polygon: [[lon, lat], …] }]`. */
    areas: jsonbArray<Record<string, unknown>>('areas'),
    /** Сообщение-источник: строка датасета (модуль data владеет строкой). */
    sourceDatasetId: uuid('source_dataset_id'),
    sourceRowId: text('source_row_id'),
    signerId: uuid('signer_id').references(() => users.id, { onDelete: 'set null' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: tsCol('approved_at'),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Время публикации — `sent` CAP. */
    publishedAt: tsCol('published_at'),
    /**
     * Документ CAP, как он выпущен: снимок на момент решения. Переименование
     * территории или правка справочника выпущенное не меняют.
     */
    capXml: text('cap_xml'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('warnings_identifier_key').on(t.identifier),
    index('warnings_status_idx').on(t.status, t.publishedAt.desc()),
    index('warnings_references_idx').on(t.referencesId),
    index('warnings_source_idx')
      .on(t.sourceDatasetId, t.sourceRowId)
      .where(sql`${t.sourceDatasetId} IS NOT NULL`),
  ],
)

export type WarningRow = typeof warnings.$inferSelect
