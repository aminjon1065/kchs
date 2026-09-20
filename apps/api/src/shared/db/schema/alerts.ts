import { sql } from 'drizzle-orm'
import { boolean, doublePrecision, index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbArray, jsonbObject, tsCol, updatedAt } from './_shared.js'
import { metrics } from './data.js'
import { objects } from './kernel.js'

/**
 * Алерты на показатели (06-analytics-engine.md §14, ADR-0104). Алерт — объект
 * реестра (`objects.type = 'alert'`); проверка идёт одним объявленным
 * расписанием планировщика ядра (ADR-0096) по `next_run_at`, второго
 * планировщика в платформе нет.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    metricId: uuid('metric_id')
      .notNull()
      .references(() => metrics.id, { onDelete: 'cascade' }),
    definition: jsonbObject('definition'),
    enabled: boolean('enabled').notNull().default(false),
    /** Денормализовано из определения: выборка проверок и экран «Расписания». */
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull(),
    conditionKind: text('condition_kind').notNull(),
    lastCheckedAt: tsCol('last_checked_at'),
    lastFiredAt: tsCol('last_fired_at'),
    /** Ближайшая проверка: выбирается заданием-тиком. */
    nextRunAt: tsCol('next_run_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('alerts_metric_idx').on(t.metricId),
    index('alerts_due_idx').on(t.enabled, t.nextRunAt),
  ],
)

/**
 * История срабатываний: карточка алерта и отметки на графике показателя.
 * Период тишины (`cooldown`) считается по последнему срабатыванию разреза.
 */
export const alertEvents = pgTable(
  'alert_events',
  {
    id: uuid('id').primaryKey(),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    metricId: uuid('metric_id')
      .notNull()
      .references(() => metrics.id, { onDelete: 'cascade' }),
    firedAt: tsCol('fired_at')
      .notNull()
      .default(sql`now()`),
    /** Ключ разреза; пустая строка — показатель целиком. */
    groupKey: text('group_key').notNull().default(''),
    groupLabel: text('group_label').notNull().default(''),
    groupValues: jsonbObject('group_values'),
    value: doublePrecision('value'),
    base: doublePrecision('base'),
    /** Отклонение в процентах или z-score — по виду условия. */
    score: doublePrecision('score'),
    message: text('message').notNull(),
    channels: jsonbArray<string>('channels'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('alert_events_alert_idx').on(t.alertId, t.firedAt.desc()),
    index('alert_events_metric_idx').on(t.metricId, t.firedAt.desc()),
    index('alert_events_cooldown_idx').on(t.alertId, t.groupKey, t.firedAt.desc()),
  ],
)
