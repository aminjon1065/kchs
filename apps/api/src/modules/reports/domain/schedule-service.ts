import {
  type ReportSchedule,
  ReportScheduleInput,
  reportCronPattern,
  type UserRef,
} from '@kchs/contracts'
import cronParser from 'cron-parser'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { queue } from '~/kernel/jobs/service.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, reports, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { ReportService } from './report-service.js'
import { ReportRuns } from './run-service.js'

/**
 * Планировщик рассылки (14-automation-integrations.md §2): повторяемое задание
 * BullMQ на отчёт в очереди `automation` (исполнитель — воркер, ADR-0035).
 */
export const REPORT_SCHEDULE_JOB = { queue: 'automation', name: 'report.scheduled' } as const

// Без «:» — иначе BullMQ читает отсутствующий планировщик как ключ старого формата
const SCHEDULER_PREFIX = 'report-'
const schedulerId = (reportId: string) => `${SCHEDULER_PREFIX}${reportId}`

/** Рассылка — не чаще раза в час: это отчёт, а не опрос данных. */
const MIN_INTERVAL_MS = 60 * 60_000

/** Расписание в `reports.schedule`: ввод и кто его задал. */
interface StoredSchedule extends ReportScheduleInput {
  updatedBy: string | null
  updatedAt: string
}

function stored(value: unknown): StoredSchedule | null {
  if (!value || typeof value !== 'object') return null
  const parsed = ReportScheduleInput.safeParse(value)
  if (!parsed.success) return null
  const extra = value as { updatedBy?: unknown; updatedAt?: unknown }
  return {
    ...parsed.data,
    updatedBy: typeof extra.updatedBy === 'string' ? extra.updatedBy : null,
    updatedAt: typeof extra.updatedAt === 'string' ? extra.updatedAt : new Date(0).toISOString(),
  }
}

function validTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}

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

/** Выражение пяти полей, пояс IANA, не чаще раза в час. */
function assertPattern(pattern: string, timezone: string): void {
  if (!validTimezone(timezone)) throw errors.validation('Неизвестный часовой пояс')
  if (pattern.split(' ').length !== 5) {
    throw errors.validation('Выражение cron — пять полей: минута, час, день, месяц, день недели')
  }
  let runs: Date[]
  try {
    runs = nextRuns(pattern, timezone, 6)
  } catch {
    throw errors.validation('Неверное выражение cron')
  }
  for (let index = 1; index < runs.length; index++) {
    const gap = (runs[index] as Date).getTime() - (runs[index - 1] as Date).getTime()
    if (gap < MIN_INTERVAL_MS) throw errors.validation('Рассылка отчёта — не чаще раза в час')
  }
}

async function loadReport(tx: Executor, reportId: string) {
  const [row] = await tx
    .select({
      schedule: reports.schedule,
      deletedAt: objects.deletedAt,
      archivedAt: objects.archivedAt,
      spaceId: objects.spaceId,
      title: objects.title,
    })
    .from(reports)
    .innerJoin(objects, eq(objects.id, reports.id))
    .where(eq(reports.id, reportId))
    .limit(1)
  return row ?? null
}

/** Получатели, которые сейчас не видят отчёт: им рассылка не придёт. */
async function withoutAccess(reportId: string, userIds: string[]): Promise<string[]> {
  const out: string[] = []
  for (const userId of userIds) {
    const ctx = await buildUserCtxFor(userId)
    const decision = ctx ? await authorize(ctx, 'view', reportId, { soft: true }) : null
    if (!decision?.allowed) out.push(userId)
  }
  return out
}

/**
 * Получатели рассылки на момент рассылки (ADR-0164): сотрудники, участники групп и
 * обладатели ролей — без повторов, только действующие.
 */
async function expandRecipients(value: StoredSchedule): Promise<string[]> {
  const ids = new Set(value.recipients)
  for (const groupId of value.groups) {
    for (const userId of await directory().groupMembers(groupId)) ids.add(userId)
  }
  for (const role of value.roles) {
    const holders = await directory().usersWithRole(role, { spaceId: null, scope: 'effective' })
    for (const userId of holders) ids.add(userId)
  }
  return directory().activeUsers([...ids])
}

/** Гриф отчёта «Конфиденциально»: внешним адресам рассылка не уходит (как ADR-0149). */
async function externalBlocked(reportId: string): Promise<boolean> {
  const [row] = await db()
    .select({ confidentiality: objects.confidentiality })
    .from(objects)
    .where(eq(objects.id, reportId))
    .limit(1)
  return row?.confidentiality === 'confidential'
}

async function toSchedule(reportId: string, value: StoredSchedule): Promise<ReportSchedule> {
  const pattern = reportCronPattern(value)
  let nextRunAt: string | null = null
  if (value.enabled) {
    try {
      nextRunAt = nextRuns(pattern, value.timezone, 1)[0]?.toISOString() ?? null
    } catch {
      nextRunAt = null
    }
  }
  const ids = [...new Set([...value.recipients, ...(value.updatedBy ? [value.updatedBy] : [])])]
  const refs = await directory().refs(ids)
  const { updatedBy, updatedAt, ...input } = value
  return {
    ...input,
    pattern,
    nextRunAt,
    recipientRefs: value.recipients
      .map((id) => refs.get(id))
      .filter((ref): ref is UserRef => Boolean(ref)),
    expandedCount: (await expandRecipients(value)).filter((id) => !value.recipients.includes(id))
      .length,
    externalBlocked: value.emails.length > 0 && (await externalBlocked(reportId)),
    recipientsWithoutAccess: await withoutAccess(reportId, value.recipients),
    updatedBy: updatedBy ? (refs.get(updatedBy) ?? null) : null,
    updatedAt,
  }
}

/**
 * Расписание и рассылка отчёта (P2-E05 S05, ADR-0078). Права получателей:
 * каждый получает свой рендер под своими правами (политики строк и столбцов,
 * доступ к графикам и картам) — отчёт не пересылает чужие данные. Получатель без
 * права `view` на отчёт пропускается и видит это в истории запусков.
 */
export const ReportSchedules = {
  async get(reportId: string): Promise<ReportSchedule | null> {
    const row = await loadReport(db(), reportId)
    if (!row) throw errors.notFound('Отчёт')
    const value = stored(row.schedule)
    return value ? toSchedule(reportId, value) : null
  },

  async set(ctx: UserCtx, reportId: string, input: ReportScheduleInput): Promise<ReportSchedule> {
    const pattern = reportCronPattern(input)
    assertPattern(pattern, input.timezone)
    const recipients = [...new Set(input.recipients)]
    const found = await db()
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, recipients), eq(users.status, 'active')))
    if (found.length !== recipients.length) {
      throw errors.validation('Получатели — действующие сотрудники')
    }
    if (recipients.length + input.groups.length + input.roles.length + input.emails.length === 0) {
      throw errors.validation('Укажите получателей: сотрудников, группы, роли или адреса')
    }
    const value: StoredSchedule = {
      ...input,
      recipients,
      groups: [...new Set(input.groups)],
      roles: [...new Set(input.roles)],
      emails: [...new Set(input.emails.map((email) => email.toLowerCase()))],
      formats: [...new Set(input.formats)],
      channels: [...new Set(input.channels)],
      cron: input.frequency === 'cron' ? pattern : null,
      updatedBy: ctx.userId,
      updatedAt: new Date().toISOString(),
    }
    await db().transaction(async (tx) => {
      const row = await loadReport(tx, reportId)
      if (!row) throw errors.notFound('Отчёт')
      await tx
        .update(reports)
        .set({ schedule: value as unknown as Record<string, unknown>, updatedAt: sql`now()` })
        .where(eq(reports.id, reportId))
      await publishEvent(tx, ctx, {
        type: 'report.schedule_changed',
        object: { id: reportId, type: 'report', spaceId: row.spaceId, title: row.title },
        payload: {
          enabled: value.enabled,
          frequency: value.frequency,
          recipients: value.recipients.length,
        },
      })
    })
    return toSchedule(reportId, value)
  },

  async remove(ctx: UserCtx, reportId: string): Promise<void> {
    await db().transaction(async (tx) => {
      const row = await loadReport(tx, reportId)
      if (!row) throw errors.notFound('Отчёт')
      if (!row.schedule) return
      await tx
        .update(reports)
        .set({ schedule: null, updatedAt: sql`now()` })
        .where(eq(reports.id, reportId))
      await publishEvent(tx, ctx, {
        type: 'report.schedule_changed',
        object: { id: reportId, type: 'report', spaceId: row.spaceId, title: row.title },
        payload: { enabled: false, frequency: null, recipients: 0 },
      })
    })
  },

  /**
   * Запуск рассылки: по запуску на получателя — под его правами. Вызывает
   * планировщик (`automation:report.scheduled`) и «Отправить сейчас».
   */
  async fire(
    reportId: string,
    options: { force?: boolean } = {},
  ): Promise<{
    runs: number
    skipped: number
  }> {
    const row = await loadReport(db(), reportId)
    const value = row ? stored(row.schedule) : null
    if (!row || row.deletedAt || row.archivedAt || !value || (!value.enabled && !options.force)) {
      // Отчёт удалён, в архиве или рассылка снята — планировщик больше не нужен
      await ReportSchedules.sync(reportId)
      return { runs: 0, skipped: 0 }
    }
    const report = await ReportService.get(reportId)
    const ctx: Ctx = systemCtx('report.schedule', { initiatorId: value.updatedBy })
    // Группы и роли — на момент рассылки: новый участник группы получает отчёт сразу
    const recipients = await expandRecipients(value)
    const denied = new Set(await withoutAccess(reportId, recipients))
    const active = new Set(
      recipients.length === 0
        ? []
        : (
            await db()
              .select({ id: users.id })
              .from(users)
              .where(and(inArray(users.id, recipients), eq(users.status, 'active')))
          ).map((user) => user.id),
    )
    const blockedOutside = value.emails.length > 0 && (await externalBlocked(reportId))
    let runs = 0
    let skipped = 0
    await db().transaction(async (tx) => {
      // Внешние адреса: один запуск под правами автора рассылки, письмо — им (ADR-0164)
      if (value.emails.length > 0 && value.updatedBy) {
        const input = {
          reportId,
          runAs: value.updatedBy,
          requestedBy: value.updatedBy,
          trigger: 'schedule' as const,
          params: value.params ?? report.params,
          formats: value.formats,
          channels: ['email' as const],
          externalEmails: value.emails,
        }
        const authorDenied = (await withoutAccess(reportId, [value.updatedBy])).length > 0
        if (blockedOutside || authorDenied) {
          await ReportRuns.recordSkipped(tx, ctx, {
            ...input,
            reason: blockedOutside
              ? 'Отчёт с грифом «Конфиденциально» на внешние адреса не отправляется'
              : 'У автора рассылки нет доступа к отчёту',
          })
          skipped += 1
        } else {
          await ReportRuns.enqueue(tx, ctx, input)
          runs += 1
        }
      }
      for (const userId of recipients) {
        const input = {
          reportId,
          runAs: userId,
          requestedBy: value.updatedBy,
          trigger: 'schedule' as const,
          params: value.params ?? report.params,
          formats: value.formats,
          channels: value.channels,
        }
        if (!active.has(userId) || denied.has(userId)) {
          await ReportRuns.recordSkipped(tx, ctx, { ...input, reason: 'Нет доступа к отчёту' })
          skipped += 1
        } else {
          await ReportRuns.enqueue(tx, ctx, input)
          runs += 1
        }
      }
    })
    logger().info({ reportId, runs, skipped }, 'рассылка отчёта поставлена')
    return { runs, skipped }
  },

  /** «Отправить сейчас»: рассылка вне расписания — управляющий отчётом. */
  async runNow(reportId: string): Promise<{ runs: number; skipped: number }> {
    const row = await loadReport(db(), reportId)
    if (!row) throw errors.notFound('Отчёт')
    if (!stored(row.schedule)) throw errors.validation('Сначала задайте получателей рассылки')
    return ReportSchedules.fire(reportId, { force: true })
  },

  /**
   * Планировщик BullMQ по состоянию в базе: включённая рассылка живого отчёта —
   * повторяемое задание с выражением и поясом, иначе — снять.
   */
  async sync(reportId: string): Promise<void> {
    const row = await loadReport(db(), reportId)
    const value = row ? stored(row.schedule) : null
    const automation = queue(REPORT_SCHEDULE_JOB.queue)
    if (!row || row.deletedAt || row.archivedAt || !value?.enabled) {
      await automation.removeJobScheduler(schedulerId(reportId))
      return
    }
    await automation.upsertJobScheduler(
      schedulerId(reportId),
      { pattern: reportCronPattern(value), tz: value.timezone },
      {
        name: REPORT_SCHEDULE_JOB.name,
        data: { reportId },
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
      },
    )
  },

  /** При старте воркера: планировщики всех рассылок, лишние — снять. */
  async syncAll(): Promise<number> {
    const rows = await db()
      .select({ id: reports.id })
      .from(reports)
      .innerJoin(objects, eq(objects.id, reports.id))
      .where(
        and(
          isNotNull(reports.schedule),
          isNull(objects.deletedAt),
          sql`${reports.schedule} ->> 'enabled' = 'true'`,
        ),
      )
    const wanted = new Set(rows.map((row) => row.id))
    for (const id of wanted) await ReportSchedules.sync(id)
    const automation = queue(REPORT_SCHEDULE_JOB.queue)
    for (const scheduler of await automation.getJobSchedulers(0, -1)) {
      const key = scheduler.key ?? scheduler.id
      if (typeof key !== 'string' || !key.startsWith(SCHEDULER_PREFIX)) continue
      if (!wanted.has(key.slice(SCHEDULER_PREFIX.length))) await automation.removeJobScheduler(key)
    }
    return wanted.size
  },
}
