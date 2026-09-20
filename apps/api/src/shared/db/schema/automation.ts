import { sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbArray, jsonbObject, tsCol, updatedAt } from './_shared.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Правила автоматизации (14-automation-integrations.md §1, ADR-0096).
 * Правило — объект реестра (`objects.type = 'rule'`), здесь — его определение
 * и служебные поля исполнения. Столбцы `trigger_kind`, `event_type`, `cron`
 * денормализованы из определения ради выборки подписчиком и планировщиком.
 */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Стабильный ключ для экспорта конфигурации между контурами. */
    key: text('key').notNull().unique(),
    definition: jsonbObject('definition'),
    enabled: boolean('enabled').notNull().default(false),
    /** Служебный пользователь правила: действия выполняются от его имени. */
    runAs: uuid('run_as').references(() => users.id, { onDelete: 'set null' }),
    triggerKind: text('trigger_kind').notNull(),
    /** Тип события каталога или префикс домена — для триггера `event`. */
    eventType: text('event_type'),
    cron: text('cron'),
    timezone: text('timezone'),
    /** Ключ входящего вызова (`webhook.received`). */
    hookKey: text('hook_key'),
    /** Секрет адреса входящего вызова правила. */
    webhookToken: text('webhook_token').unique(),
    lastRunAt: tsCol('last_run_at'),
    lastStatus: text('last_status'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('rules_trigger_idx').on(t.triggerKind, t.enabled),
    index('rules_event_idx').on(t.eventType),
    index('rules_hook_idx').on(t.hookKey),
  ],
)

/**
 * Журнал запусков с логом шагов (contracts/automation-rule.md §Правила
 * исполнения). Идемпотентность события — уникальный индекс `(rule_id, event_id)`
 * для настоящих запусков; тестовые прогоны в журнал не пишутся.
 */
export const ruleRuns = pgTable(
  'rule_runs',
  {
    id: uuid('id').primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    /** Событие-повод: по нему считается глубина каузальной цепочки. */
    eventId: text('event_id'),
    eventType: text('event_type'),
    triggerKind: text('trigger_kind').notNull(),
    status: text('status').notNull().default('queued'),
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'set null' }),
    /** От чьего имени выполнялся запуск (`run_as` на момент запуска). */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    depth: integer('depth').notNull().default(0),
    /** Конверт события или данные запуска: воркер исполняет по ним. */
    context: jsonbObject('context'),
    steps: jsonbArray('steps'),
    /** Индекс действия, с которого продолжить после `wait`. */
    resumeAt: integer('resume_at').notNull().default(0),
    error: text('error'),
    startedAt: tsCol('started_at'),
    finishedAt: tsCol('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('rule_runs_rule_idx').on(t.ruleId, t.createdAt.desc()),
    index('rule_runs_created_idx').on(t.createdAt.desc()),
    index('rule_runs_cause_idx').on(t.eventId),
    uniqueIndex('rule_runs_event_key').on(t.ruleId, t.eventId).where(sql`event_id is not null`),
  ],
)

/**
 * Окно дедупликации по `limits.dedupeKey`: вставка с `on conflict do nothing`
 * решает, первый ли это запуск с таким ключом. Просроченные ключи убирает
 * обслуживание вместе со старыми запусками.
 */
export const ruleDedupe = pgTable(
  'rule_dedupe',
  {
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    expiresAt: tsCol('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('rule_dedupe_key').on(t.ruleId, t.key),
    index('rule_dedupe_expires_idx').on(t.expiresAt),
  ],
)

/**
 * Состояние расписаний платформы (14-automation-integrations.md §2):
 * администратор выключает системную проверку, не трогая код. Правила по cron
 * включаются собственным переключателем правила.
 */
export const schedules = pgTable('schedules', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
})
