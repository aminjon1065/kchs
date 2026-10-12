import { sql } from 'drizzle-orm'
import { bigint, boolean, index, text, uuid } from 'drizzle-orm/pg-core'
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

/**
 * Проверки восстановления на резервном узле (ADR-0199): `dr.sh restore-check`
 * поднимает копию из архива, проверяет её и сообщает итог токеном служебной
 * записи. История проверок видна в консоли рядом с копиями; удачная проверка
 * копии `pg_dump` отмечает и саму копию.
 */
export const restoreChecks = opsSchema.table(
  'restore_checks',
  {
    id: uuid('id').primaryKey(),
    /** pitr — базовая копия и архив WAL резервного узла; dump — копия pg_dump. */
    kind: text('kind').notNull(),
    ok: boolean('ok').notNull(),
    startedAt: tsCol('started_at').notNull(),
    finishedAt: tsCol('finished_at').notNull(),
    backupId: uuid('backup_id'),
    /** Время последней транзакции восстановленной копии. */
    recoveredTo: tsCol('recovered_to'),
    host: text('host'),
    details: text('details').notNull().default(''),
    /** Служебная запись, чьим токеном сообщён итог. */
    reportedBy: uuid('reported_by'),
    createdAt: tsCol('created_at').notNull().default(sql`now()`),
  },
  (t) => [index('restore_checks_created_idx').on(t.createdAt)],
)
