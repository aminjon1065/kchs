import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from '../../kernel/directory/schema.js'
import { objects } from '../../kernel/objects/schema.js'
import { createdAt, jsonbArray, jsonbObject, tsCol, updatedAt } from '../../shared/db/columns.js'

/**
 * Отчёт — объект реестра типа `report` (06-analytics-engine.md §12, ADR-0078).
 * Шаблон правится совместно в `yjs.documents`; здесь — его JSON-снимок (блоки,
 * параметры, настройки печати) и расписание рассылки.
 */
export const reports = pgTable('reports', {
  id: uuid('id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  blocks: jsonbArray('blocks'),
  params: jsonbObject('params'),
  settings: jsonbObject('settings'),
  /** `ReportScheduleInput` и кто его задал; null — рассылки нет. */
  schedule: jsonb('schedule').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * Версии шаблона отчёта (ADR-0164): снимок блоков, параметров и настроек печати — вручную
 * («Сохранить версию»), при «Сформировать» и перед откатом. Откат пишет снимок в документ.
 */
export const reportVersions = pgTable(
  'report_versions',
  {
    id: uuid('id').primaryKey(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    blocks: jsonbArray('blocks'),
    params: jsonbObject('params'),
    settings: jsonbObject('settings'),
    /** manual | run | restore */
    reason: text('reason').notNull(),
    label: text('label'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('report_versions_number_key').on(t.reportId, t.number)],
)

/**
 * Запуск рендера отчёта: под чьими правами (`run_as`), параметры, файлы в бакете
 * экспортов, доставка по каналам. Расписание даёт запуск на каждого получателя.
 */
export const reportRuns = pgTable(
  'report_runs',
  {
    id: uuid('id').primaryKey(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    runAs: uuid('run_as')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    params: jsonbObject('params'),
    formats: text('formats').array().notNull().default(sql`'{pdf}'::text[]`),
    /** Каналы доставки запуска по расписанию; у «Сформировать» — пусто. */
    channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
    /** Внешние адреса рассылки (ADR-0164): письмо им, а не тому, под чьими правами отчёт. */
    externalEmails: text('external_emails').array().notNull().default(sql`'{}'::text[]`),
    status: text('status').notNull().default('queued'),
    jobId: uuid('job_id'),
    /** Сколько раз движок начинал рендер: номер попытки в `report.run_started`. */
    attempts: integer('attempts').notNull().default(0),
    /** `[{format, key, fileName, size}]` — ключи в бакете экспортов. */
    files: jsonbArray('files'),
    pages: integer('pages'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    /** Итог доставки по каналам: `{inbox: 'sent', telegram: 'unavailable', …}`. */
    delivery: jsonbObject('delivery'),
    createdAt: createdAt(),
    startedAt: tsCol('started_at'),
    finishedAt: tsCol('finished_at'),
  },
  (t) => [
    index('report_runs_report_idx').on(t.reportId, t.createdAt),
    index('report_runs_run_as_idx').on(t.runAs, t.createdAt),
  ],
)
