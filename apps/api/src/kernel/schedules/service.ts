import type { QueueName, ScheduleRecord, ScheduleRun } from '@kchs/contracts'
import cronParser from 'cron-parser'
import { desc, eq, sql } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { jobs, schedules } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { queue } from '../jobs/service.js'
import { listSchedules, scheduleDefinition } from './registry.js'

/**
 * Состояние единого планировщика: объявленные регулярные задания платформы и
 * расписания правил автоматизации (их ведёт модуль `automation` через порт —
 * ядро не знает о модулях).
 */
export interface RuleScheduleEntry {
  ruleId: string
  title: string
  cron: string
  timezone: string
  enabled: boolean
  queue: QueueName
  job: string
  lastRunAt: string | null
  lastStatus: string | null
}

export interface RuleScheduleProvider {
  list(): Promise<RuleScheduleEntry[]>
  setEnabled(ctx: UserCtx, ruleId: string, enabled: boolean): Promise<void>
  runNow(ctx: UserCtx, ruleId: string): Promise<void>
}

let ruleProvider: RuleScheduleProvider | null = null

/** Модуль автоматизации подключает свои расписания к экрану (ADR-0096). */
export function setRuleScheduleProvider(provider: RuleScheduleProvider): void {
  ruleProvider = provider
}

/** Идентификатор планировщика BullMQ: без «:» — иначе читается как ключ старого формата. */
const schedulerId = (key: string) => `sys-${key.replace(/:/g, '-')}`

/** Ближайшие запуски выражения cron в поясе расписания. */
export function nextRuns(
  pattern: string,
  timezone: string,
  count: number,
  from = new Date(),
): Date[] {
  const interval = cronParser.parseExpression(pattern, { currentDate: from, tz: timezone })
  const out: Date[] = []
  for (let index = 0; index < count; index++) out.push(interval.next().toDate())
  return out
}

export function nextRunAt(pattern: string, timezone: string): string | null {
  try {
    return nextRuns(pattern, timezone, 1)[0]?.toISOString() ?? null
  } catch {
    return null
  }
}

/** Выключенные администратором расписания. */
async function disabledKeys(): Promise<Set<string>> {
  const rows = await db()
    .select({ key: schedules.key, enabled: schedules.enabled })
    .from(schedules)
    .where(eq(schedules.enabled, false))
  return new Set(rows.map((row) => row.key))
}

/**
 * Приводит планировщик BullMQ к объявленному состоянию: включённые задания —
 * повторяемые, выключенные — сняты. Снимает и записи старого формата
 * (`cron:*`), оставшиеся от прежних запусков.
 */
export async function syncSchedules(): Promise<number> {
  const disabled = await disabledKeys()
  const definitions = listSchedules()
  const timezone = config().TZ
  const touched = new Set<QueueName>()

  for (const definition of definitions) {
    const bull = queue(definition.queue)
    touched.add(definition.queue)
    if (disabled.has(definition.key)) {
      await bull.removeJobScheduler(schedulerId(definition.key))
      continue
    }
    await bull.upsertJobScheduler(
      schedulerId(definition.key),
      { pattern: definition.pattern, tz: timezone },
      { name: definition.name, data: definition.data ?? {} },
    )
  }

  const known = new Set(definitions.map((definition) => schedulerId(definition.key)))
  for (const name of touched) {
    const bull = queue(name)
    for (const scheduler of await bull.getJobSchedulers(0, -1)) {
      const key = scheduler.key ?? scheduler.id
      if (typeof key !== 'string') continue
      // Записи прежнего формата и снятые задания: планировщик ведёт только реестр
      if (key.startsWith('cron:') || (key.startsWith('sys-') && !known.has(key))) {
        await bull.removeJobScheduler(key)
      }
    }
  }

  const active = definitions.length - definitions.filter((d) => disabled.has(d.key)).length
  logger().info({ declared: definitions.length, active }, 'расписания платформы синхронизированы')
  return active
}

/** Последний запуск задания по реестру заданий. */
async function lastRuns(): Promise<Map<string, ScheduleRecord['lastRun']>> {
  const rows = await db()
    .select({
      queue: jobs.queue,
      name: jobs.name,
      status: jobs.status,
      message: jobs.message,
      createdAt: jobs.createdAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(sql`${jobs.createdAt} > now() - interval '30 days'`)
    .orderBy(desc(jobs.createdAt))
    .limit(2000)

  const out = new Map<string, ScheduleRecord['lastRun']>()
  for (const row of rows) {
    const key = `${row.queue}:${row.name}`
    if (out.has(key)) continue
    out.set(key, {
      at: row.finishedAt ?? row.startedAt ?? row.createdAt,
      status: row.status,
      durationMs:
        row.startedAt && row.finishedAt
          ? Math.max(0, Date.parse(row.finishedAt) - Date.parse(row.startedAt))
          : null,
      message: row.message,
    })
  }
  return out
}

export const ScheduleService = {
  /** Расписания платформы и правил: ближайший запуск, последний запуск, состояние. */
  async list(): Promise<ScheduleRecord[]> {
    const [disabled, history] = await Promise.all([disabledKeys(), lastRuns()])
    const timezone = config().TZ
    const items: ScheduleRecord[] = listSchedules().map((definition) => {
      const enabled = !disabled.has(definition.key)
      return {
        key: definition.key,
        kind: 'system' as const,
        labelKey: definition.labelKey,
        title: null,
        queue: definition.queue,
        job: definition.name,
        cron: definition.pattern,
        timezone,
        enabled,
        nextRunAt: enabled ? nextRunAt(definition.pattern, timezone) : null,
        lastRun: history.get(definition.key) ?? null,
        ruleId: null,
      }
    })

    for (const entry of (await ruleProvider?.list()) ?? []) {
      items.push({
        key: `rule:${entry.ruleId}`,
        kind: 'rule',
        labelKey: null,
        title: entry.title,
        queue: entry.queue,
        job: entry.job,
        cron: entry.cron,
        timezone: entry.timezone,
        enabled: entry.enabled,
        nextRunAt: entry.enabled ? nextRunAt(entry.cron, entry.timezone) : null,
        lastRun: entry.lastRunAt
          ? {
              at: entry.lastRunAt,
              status: entry.lastStatus ?? 'unknown',
              durationMs: null,
              message: null,
            }
          : null,
        ruleId: entry.ruleId,
      })
    }
    return items
  },

  /** Включает или выключает расписание: системное — в базе, правила — в правиле. */
  async setEnabled(ctx: UserCtx, key: string, enabled: boolean): Promise<ScheduleRecord> {
    if (key.startsWith('rule:')) {
      if (!ruleProvider) throw errors.notFound('Расписание')
      await ruleProvider.setEnabled(ctx, key.slice('rule:'.length), enabled)
    } else {
      const definition = scheduleDefinition(key)
      if (!definition) throw errors.notFound('Расписание')
      await db()
        .insert(schedules)
        .values({ key, enabled, updatedBy: ctx.userId })
        .onConflictDoUpdate({
          target: schedules.key,
          set: { enabled, updatedBy: ctx.userId, updatedAt: sql`now()` },
        })
      await syncSchedules()
    }
    const record = (await ScheduleService.list()).find((item) => item.key === key)
    if (!record) throw errors.notFound('Расписание')
    return record
  },

  /** Запуск вне расписания: «Выполнить сейчас». */
  async runNow(ctx: UserCtx, key: string): Promise<void> {
    if (key.startsWith('rule:')) {
      if (!ruleProvider) throw errors.notFound('Расписание')
      await ruleProvider.runNow(ctx, key.slice('rule:'.length))
      return
    }
    const definition = scheduleDefinition(key)
    if (!definition) throw errors.notFound('Расписание')
    await queue(definition.queue).add(definition.name, definition.data ?? {})
  },

  /** История запусков системного задания — реестр заданий. */
  async runs(key: string, limit: number): Promise<ScheduleRun[]> {
    const definition = scheduleDefinition(key)
    if (!definition) throw errors.notFound('Расписание')
    const rows = await db()
      .select()
      .from(jobs)
      .where(sql`${jobs.queue} = ${definition.queue} and ${jobs.name} = ${definition.name}`)
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      message: row.message,
      error: typeof row.error?.message === 'string' ? row.error.message : null,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
    }))
  },
}
