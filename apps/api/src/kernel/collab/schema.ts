import { sql } from 'drizzle-orm'
import { uuid } from 'drizzle-orm/pg-core'
import { bytea, tsCol, yjsSchema } from '../../shared/db/columns.js'
import { objects } from '../objects/schema.js'

/**
 * Документы совместного редактирования (Yjs, ADR-0070): состояние удаляется
 * вместе с объектом.
 */
export const yjsDocuments = yjsSchema.table('documents', {
  objectId: uuid('object_id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: tsCol('updated_at').notNull().default(sql`now()`),
})
