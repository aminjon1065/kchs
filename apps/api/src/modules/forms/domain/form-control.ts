import type {
  FormCellState,
  FormControl,
  FormControlQuery,
  FormControlRow,
  FormDuty,
  FormDutyList,
  FormPeriodOption,
  FormSubject,
} from '@kchs/contracts'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { forms, objects } from '~/shared/db/schema/index.js'
import { FormService, type FormRow, subjectsFor } from './form-service.js'
import { calendarSpan, dueAtOf, type FormPeriod, recentPeriods, today } from './periods.js'
import { subjectKey, subjectNames } from './subject-names.js'
import { submissionsOf } from './submission-service.js'

/**
 * Контроль сдачи (06-analytics-engine.md §13, ADR-0103): матрица
 * «назначения × периоды» со статусом каждой сводки. Права — обычные:
 * матрицу целиком видит тот, кто распоряжается формой, назначенный видит
 * свои строки.
 */

/** Сроки периодов одной загрузкой календаря. */
async function dueDates(form: FormRow, periods: FormPeriod[]): Promise<Map<string, string>> {
  const span = calendarSpan(periods)
  const kindOf = span ? await BusinessCalendar.dayKinds(span.from, span.to) : () => undefined
  return new Map(
    periods.map((period) => [
      period.key,
      dueAtOf(period, form.definition.schedule, config().TZ, kindOf).toISOString(),
    ]),
  )
}

export const FormControlService = {
  async matrix(ctx: UserCtx, formId: string, query: FormControlQuery): Promise<FormControl> {
    await authorize(ctx, 'view', formId)
    const form = await FormService.require(db(), formId)
    const manage = await authorize(ctx, 'manage', formId, { soft: true })
    const own = subjectsFor(ctx, form)
    const subjects: FormSubject[] = manage.allowed
      ? form.definition.assignments
      : (own as FormSubject[])

    const periods = recentPeriods(today(config().TZ), form.definition.schedule, query.periods)
    const [due, submissions, names] = await Promise.all([
      dueDates(form, periods),
      submissionsOf(formId, periods.map((period) => period.key)),
      subjectNames(subjects),
    ])
    const byCell = new Map(
      submissions.map((row) => [
        `${row.subjectKind}:${row.subjectId}|${row.periodKey}`,
        row,
      ]),
    )
    const now = Date.now()
    const totals = { expected: 0, accepted: 0, submitted: 0, overdue: 0 }

    const rows: FormControlRow[] = subjects.map((subject) => ({
      subject,
      name: names.get(subjectKey(subject)) ?? subjectKey(subject),
      cells: periods.map((period) => {
        const row = byCell.get(`${subject.kind}:${subject.id}|${period.key}`)
        const dueAt = row?.dueAt ?? due.get(period.key) ?? null
        const state = (row?.status ?? 'missing') as FormCellState
        const overdue =
          state !== 'accepted' &&
          state !== 'submitted' &&
          dueAt !== null &&
          Date.parse(dueAt) < now
        totals.expected += 1
        if (state === 'accepted') totals.accepted += 1
        if (state === 'submitted') totals.submitted += 1
        if (overdue) totals.overdue += 1
        return {
          periodKey: period.key,
          state,
          submissionId: row?.id ?? null,
          overdue,
        }
      }),
    }))

    return {
      formId,
      periods: periods.map((period) => ({
        key: period.key,
        start: period.start,
        end: period.end,
        dueAt: due.get(period.key) ?? null,
      })),
      rows: query.state
        ? rows.filter((row) => row.cells.some((cell) => cell.state === query.state))
        : rows,
      totals,
    }
  },

  /** Что предстоит сдать смотрящему: формы, его назначения и периоды. */
  async duties(ctx: UserCtx, limit = 20): Promise<FormDutyList> {
    const rows = await db()
      .select({ id: forms.id })
      .from(forms)
      .innerJoin(objects, eq(objects.id, forms.id))
      .where(and(eq(forms.enabled, true), isNull(objects.deletedAt)))
      .orderBy(desc(objects.updatedAt))
      .limit(100)

    const items: FormDuty[] = []
    for (const { id } of rows) {
      if (items.length >= limit) break
      const decision = await authorize(ctx, 'view', id, { soft: true })
      if (!decision.allowed) continue
      const form = await FormService.require(db(), id)
      const own = subjectsFor(ctx, form)
      if (own.length === 0) continue
      const periods = recentPeriods(today(config().TZ), form.definition.schedule, 6)
      const [due, submissions, names] = await Promise.all([
        dueDates(form, periods),
        submissionsOf(id, periods.map((period) => period.key)),
        subjectNames(own as FormSubject[]),
      ])
      for (const subject of own as FormSubject[]) {
        const options: FormPeriodOption[] = periods.map((period) => {
          const row = submissions.find(
            (item) =>
              item.periodKey === period.key &&
              item.subjectKind === subject.kind &&
              item.subjectId === subject.id,
          )
          return {
            key: period.key,
            start: period.start,
            end: period.end,
            dueAt: row?.dueAt ?? due.get(period.key) ?? null,
            state: (row?.status ?? 'missing') as FormCellState,
            submissionId: row?.id ?? null,
          }
        })
        items.push({
          formId: id,
          formName: form.title,
          subject,
          subjectName: names.get(subjectKey(subject)) ?? null,
          periods: options,
        })
      }
    }
    return { items }
  },
}
