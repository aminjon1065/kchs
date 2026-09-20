import type { FormSubject } from '@kchs/contracts'
import { and, eq, inArray, isNull, isNotNull, lt, sql } from 'drizzle-orm'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { formReminders, formSubmissions, forms, objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { newId } from '~/shared/ids.js'
import { type FormStage, planStages } from './form-deadlines.js'
import { FormInbox } from './form-inbox.js'
import { type FormRow, FormService, objectRef } from './form-service.js'
import { calendarSpan, closedPeriods, dueAtOf, type FormPeriod, today } from './periods.js'
import { managerOf } from './subject-names.js'

/**
 * Контроль сдачи заданием воркера (ADR-0103): открывает периоды назначенным,
 * напоминает о сроке, помечает просрочку и передаёт её руководителю.
 * Идемпотентность — уникальные индексы отправки и отметки этапа: повтор
 * задания, два воркера и перезапуск не дают дублей.
 */

/** Сколько закрытых периодов держим открытыми к сдаче. */
const OPEN_PERIODS = 3

/** Дальше этого срока этапы ещё не наступили. */
const HORIZON_MS = 14 * 86_400_000

async function enabledForms(): Promise<FormRow[]> {
  const rows = await db()
    .select({ id: forms.id })
    .from(forms)
    .innerJoin(objects, eq(objects.id, forms.id))
    .where(and(eq(forms.enabled, true), isNull(objects.deletedAt), isNull(objects.archivedAt)))
  const out: FormRow[] = []
  for (const row of rows) {
    const form = await FormService.load(db(), row.id)
    if (form) out.push(form)
  }
  return out
}

/** Периоды, которые уже можно сдавать: закрытые, у разовой формы — сразу. */
function collectablePeriods(form: FormRow, today: string): FormPeriod[] {
  const schedule = form.definition.schedule
  if (schedule.periodicity === 'once') {
    const start = schedule.startsOn ?? today
    if (start > today) return []
    return [{ key: 'once', start, end: schedule.dueOn ?? start }]
  }
  return closedPeriods(today, schedule, OPEN_PERIODS)
}

/** Открывает отправки закрытых периодов и дела «Сдать сводку». */
async function openPeriods(form: FormRow, now: Date): Promise<number> {
  const timezone = config().TZ
  const periods = collectablePeriods(form, today(timezone, now))
  if (periods.length === 0 || form.definition.assignments.length === 0) return 0
  const span = calendarSpan(periods)
  const kindOf = span ? await BusinessCalendar.dayKinds(span.from, span.to) : () => undefined
  let opened = 0

  for (const period of periods) {
    const dueAt = dueAtOf(period, form.definition.schedule, timezone, kindOf).toISOString()
    for (const subject of form.definition.assignments) {
      opened += await db().transaction(async (tx) => {
        const id = newId()
        const inserted = await tx
          .insert(formSubmissions)
          .values({
            id,
            formId: form.id,
            periodKey: period.key,
            periodStart: period.start,
            periodEnd: period.end,
            dueAt,
            subjectKind: subject.kind,
            subjectId: subject.id,
            status: 'draft',
            values: {},
          })
          .onConflictDoNothing()
          .returning({ id: formSubmissions.id })
        if (inserted.length === 0) return 0
        const ctx = systemCtx('forms.control')
        await publishEvent(tx, ctx, {
          type: 'form.assigned',
          object: await objectRef(tx, form.id),
          payload: {
            submissionId: id,
            periodKey: period.key,
            subjectKind: subject.kind,
            subjectId: subject.id,
            dueAt,
          },
        })
        await FormInbox.submit(tx, ctx, form, { id, periodKey: period.key, dueAt }, subject)
        return 1
      })
    }
  }
  return opened
}

interface DueRow {
  id: string
  formId: string
  periodKey: string
  subjectKind: string
  subjectId: string
  dueAt: string
  status: string
}

/** Напоминания, просрочка и эскалация по открытым отправкам. */
async function runReminders(now: Date): Promise<number> {
  const timezone = config().TZ
  const rows = (await db()
    .select({
      id: formSubmissions.id,
      formId: formSubmissions.formId,
      periodKey: formSubmissions.periodKey,
      subjectKind: formSubmissions.subjectKind,
      subjectId: formSubmissions.subjectId,
      dueAt: formSubmissions.dueAt,
      status: formSubmissions.status,
    })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .innerJoin(objects, eq(objects.id, formSubmissions.formId))
    .where(
      and(
        inArray(formSubmissions.status, ['draft', 'returned']),
        isNotNull(formSubmissions.dueAt),
        lt(formSubmissions.dueAt, new Date(now.getTime() + HORIZON_MS).toISOString()),
        eq(forms.enabled, true),
        isNull(objects.deletedAt),
      ),
    )) as DueRow[]
  if (rows.length === 0) return 0

  const done = await doneStages(rows.map((row) => row.id))
  const days = rows.map((row) => row.dueAt.slice(0, 10)).sort()
  const kindOf = await BusinessCalendar.dayKinds(
    shiftDay(days[0] as string, -10),
    shiftDay(days[days.length - 1] as string, 40),
  )

  let fired = 0
  for (const row of rows) {
    const form = await FormService.load(db(), row.formId)
    if (!form) continue
    const plan = planStages(
      { dueAt: new Date(row.dueAt), done: done.get(row.id) ?? new Set() },
      now,
      timezone,
      kindOf,
      form.definition.escalation,
    )
    if (plan.fire.length === 0 && plan.skip.length === 0) continue
    try {
      fired += await db().transaction((tx) => fire(tx, form, row, plan.fire, plan.skip))
    } catch (error) {
      logger().warn({ err: error, submissionId: row.id }, 'напоминание по форме не отправлено')
    }
  }
  return fired
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

async function doneStages(ids: string[]): Promise<Map<string, Set<FormStage>>> {
  if (ids.length === 0) return new Map()
  const rows = await db()
    .select({ submissionId: formReminders.submissionId, stage: formReminders.stage })
    .from(formReminders)
    .where(inArray(formReminders.submissionId, ids))
  const out = new Map<string, Set<FormStage>>()
  for (const row of rows) {
    const set = out.get(row.submissionId) ?? new Set<FormStage>()
    set.add(row.stage as FormStage)
    out.set(row.submissionId, set)
  }
  return out
}

async function fire(
  tx: Executor,
  form: FormRow,
  row: DueRow,
  stages: FormStage[],
  skip: FormStage[],
): Promise<number> {
  const [current] = await tx
    .select({ status: formSubmissions.status, dueAt: formSubmissions.dueAt })
    .from(formSubmissions)
    .where(eq(formSubmissions.id, row.id))
    .for('update')
  if (!current || !['draft', 'returned'].includes(current.status)) return 0

  const ctx = systemCtx('forms.control')
  const object = await objectRef(tx, form.id)
  const subject = { kind: row.subjectKind, id: row.subjectId } as FormSubject
  const mark = (stage: FormStage, skipped: boolean) =>
    tx
      .insert(formReminders)
      .values({ submissionId: row.id, stage, dueAt: row.dueAt, skipped })
      .onConflictDoNothing()
      .returning({ stage: formReminders.stage })

  for (const stage of skip) await mark(stage, true)
  let count = 0
  for (const stage of stages) {
    const managerId = stage === 'escalated' ? await managerOf(subject) : null
    if (stage === 'escalated' && !managerId) {
      await mark(stage, true)
      continue
    }
    const inserted = await mark(stage, false)
    if (inserted.length === 0) continue
    const base = {
      submissionId: row.id,
      periodKey: row.periodKey,
      subjectKind: subject.kind,
      subjectId: subject.id,
    }
    if (stage === 'overdue') {
      await publishEvent(tx, ctx, {
        type: 'form.overdue',
        object,
        payload: { ...base, dueAt: row.dueAt },
      })
    } else if (stage === 'escalated' && managerId) {
      await publishEvent(tx, ctx, {
        type: 'form.escalated',
        object,
        payload: { ...base, dueAt: row.dueAt, managerId },
      })
    } else {
      // Напоминание — то же дело Входящих: срок уже в нём, повтор не нужен
      await FormInbox.submit(
        tx,
        ctx,
        form,
        { id: row.id, periodKey: row.periodKey, dueAt: row.dueAt },
        subject,
      )
    }
    count += 1
  }
  return count
}

export const FormJobs = {
  /** Один проход контроля сдачи. */
  async control(now: Date = new Date()): Promise<{ opened: number; fired: number }> {
    let opened = 0
    for (const form of await enabledForms()) {
      try {
        opened += await openPeriods(form, now)
      } catch (error) {
        logger().warn({ err: error, formId: form.id }, 'периоды формы не открыты')
      }
    }
    const fired = await runReminders(now)
    return { opened, fired }
  },

  /** Старые отметки этапов: держим столько же, сколько журнал правил. */
  async prune(days = 180): Promise<number> {
    const rows = await db()
      .delete(formReminders)
      .where(sql`${formReminders.createdAt} < now() - make_interval(days => ${days})`)
      .returning({ stage: formReminders.stage })
    return rows.length
  },
}
