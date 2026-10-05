import { sql } from 'drizzle-orm'
import { bigint, index, text, uuid } from 'drizzle-orm/pg-core'
import { opsSchema, tsCol } from '../../shared/db/columns.js'

/**
 * Резервные копии базы (15-admin-operations.md §5, P5-E06): каждая запись —
 * один прогон `pg_dump` с итогом, размером и ключом в бакете копий. Копии
 * S1 делает сама установка; проверка восстановлением отмечается человеком.
 */
export const backups = opsSchema.table(
  'backups',
  {
    id: uuid('id').primaryKey(),
    status: text('status').notNull(),
    startedAt: tsCol('started_at').notNull().default(sql`now()`),
    finishedAt: tsCol('finished_at'),
    /** Ключ архива в бакете копий; null — прогон не дошёл до выгрузки. */
    key: text('key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Кто заказал копию; null — расписание. */
    requestedBy: uuid('requested_by'),
    error: text('error'),
    /** Отметка о проверке восстановлением (runbook `infra/runbooks/restore.md`). */
    verifiedAt: tsCol('verified_at'),
    verifiedBy: uuid('verified_by'),
    verifiedNote: text('verified_note'),
  },
  (t) => [index('backups_started_idx').on(t.startedAt)],
)
