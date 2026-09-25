import type {
  FormReviewInput,
  FormSubject,
  FormSubmission,
  FormSubmissionSaveInput,
  FormSubmissionStatus,
} from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { DatasetQueries, DatasetRows, datasetRecord } from '~/modules/data/public.js'
import { territoryIndex } from '~/modules/gis/public.js'
import { OrgService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { formSubmissions } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { FormInbox } from './form-inbox.js'
import { assertRunAs, type FormRow, FormService, objectRef, subjectsFor } from './form-service.js'
import { dueAtOf, type FormPeriod, recentPeriods, today } from './periods.js'
import { subjectKey, subjectNames } from './subject-names.js'
import { checkTableRows, isBlank, pickFields } from './table-rows.js'

/**
 * Отправки формы (06-analytics-engine.md §13, ADR-0103, ADR-0129): сводка
 * одного назначенного за один период. Сдача — запись строки датасета (у
 * табличной формы — строк) через публичный API модуля «Данные» с `_import_id`
 * отправки; чужих таблиц форма не трогает.
 */

export interface SubmissionRow {
  id: string
  formId: string
  periodKey: string
  periodStart: string
  periodEnd: string
  dueAt: string | null
  subjectKind: string
  subjectId: string
  status: string
  values: Record<string, unknown>
  /** Табличная форма: строки черновика или сдачи. */
  rows: Array<Record<string, unknown>> | null
  rowId: string | null
  rowIds: string[]
  authorId: string | null
  submittedAt: string | null
  reviewerId: string | null
  reviewedAt: string | null
  comment: string | null
  updatedAt: string
}

const OPEN_STATUSES: FormSubmissionStatus[] = ['draft', 'returned']

/** Период по ключу: отправка открывается только на существующий период. */
export async function periodByKey(form: FormRow, periodKey: string): Promise<FormPeriod> {
  const schedule = form.definition.schedule
  if (schedule.periodicity === 'once') {
    if (periodKey !== 'once') throw errors.validation('У разовой формы один период')
    const start = schedule.startsOn ?? (schedule.dueOn as string)
    return { key: 'once', start, end: schedule.dueOn ?? start }
  }
  const known = recentPeriods(today(config().TZ), schedule, 60).find(
    (period) => period.key === periodKey,
  )
  if (known) return known
  throw errors.validation('Такого периода у формы нет')
}

/** Момент срока периода по производственному календарю. */
async function dueFor(form: FormRow, period: FormPeriod): Promise<Date> {
  const kindOf = await BusinessCalendar.dayKinds(period.end, period.end)
  return dueAtOf(period, form.definition.schedule, config().TZ, kindOf)
}

async function loadSubmission(executor: Executor, id: string): Promise<SubmissionRow> {
  const [row] = await executor.select().from(formSubmissions).where(eq(formSubmissions.id, id))
  if (!row) throw errors.notFound('Отправка')
  return row as SubmissionRow
}

/** Может ли пользователь сдавать за это назначение. */
function maySubmit(ctx: UserCtx, form: FormRow, subject: FormSubject): boolean {
  return subjectsFor(ctx, form).some((item) => item.kind === subject.kind && item.id === subject.id)
}

async function view(
  ctx: UserCtx,
  form: FormRow,
  row: SubmissionRow,
  canManage: boolean,
): Promise<FormSubmission> {
  const subject = { kind: row.subjectKind, id: row.subjectId } as FormSubject
  const names = await subjectNames([subject])
  return {
    id: row.id,
    formId: row.formId,
    formName: form.title,
    periodKey: row.periodKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    dueAt: row.dueAt,
    subject,
    subjectName: names.get(subjectKey(subject)) ?? null,
    status: row.status as FormSubmissionStatus,
    values: row.values,
    rows: form.definition.layout === 'table' ? (row.rows ?? []) : null,
    rowId: row.rowId,
    rowIds: row.rowIds ?? [],
    authorId: row.authorId,
    submittedAt: row.submittedAt,
    reviewerId: row.reviewerId,
    reviewedAt: row.reviewedAt,
    comment: row.comment,
    canSubmit:
      OPEN_STATUSES.includes(row.status as FormSubmissionStatus) && maySubmit(ctx, form, subject),
    canReview: row.status === 'submitted' && (canManage || form.reviewers.includes(ctx.userId)),
    updatedAt: row.updatedAt,
  }
}

/** Строки табличной сводки из запроса: у табличной формы значения — только строками. */
function tableRows(input: FormSubmissionSaveInput): Array<Record<string, unknown>> {
  if (!input.rows) throw errors.validation('Табличная сводка сохраняется и сдаётся строками')
  return input.rows
}

/**
 * Контекст записи строк: права служебной учётной записи формы (ADR-0103, ADR-0130).
 * Запись проверяется в момент сдачи (ADR-0123): её могли заблокировать после включения.
 */
async function writerCtx(form: FormRow): Promise<UserCtx> {
  if (!form.runAs) {
    throw errors.validation('У формы не выбрана служебная учётная запись — сдача невозможна')
  }
  await assertRunAs(form.runAs)
  const ctx = await buildUserCtxFor(form.runAs)
  if (!ctx) throw errors.validation('Служебная учётная запись формы недоступна')
  return ctx
}

/** Значения авто-полей по их типу в датасете. */
async function autoValues(
  form: FormRow,
  row: SubmissionRow,
  authorId: string,
): Promise<Record<string, unknown>> {
  const auto = form.definition.auto
  if (!auto.unit && !auto.period && !auto.author && !auto.submittedAt) return {}
  const dataset = await datasetRecord(form.datasetId)
  const typeOf = (key: string) => dataset.fields.find((field) => field.key === key)?.type
  const out: Record<string, unknown> = {}

  if (auto.unit) {
    const unitId =
      row.subjectKind === 'unit' ? row.subjectId : await directory().primaryUnit(authorId)
    if (unitId) {
      if (typeOf(auto.unit) === 'unit') out[auto.unit] = unitId
      else {
        const briefs = await OrgService.briefs([unitId])
        out[auto.unit] = briefs.get(unitId)?.name.ru ?? unitId
      }
    }
  }
  if (auto.period) {
    const type = typeOf(auto.period)
    out[auto.period] = type === 'date' || type === 'datetime' ? row.periodStart : row.periodKey
  }
  if (auto.author) {
    out[auto.author] =
      typeOf(auto.author) === 'user' ? authorId : await directory().displayName(authorId)
  }
  if (auto.submittedAt) {
    const now = new Date()
    out[auto.submittedAt] =
      typeOf(auto.submittedAt) === 'date' ? now.toISOString().slice(0, 10) : now.toISOString()
  }
  return out
}

/**
 * Место строк (ADR-0157): форма спрашивает точку, а её не указали — точка встаёт в центр
 * территории строки (поле территории датасета), авто-поле «место приблизительное» — «да»;
 * указанная точка — «нет». Строка без точки и без территории остаётся без места.
 */
async function located(
  form: FormRow,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const dataset = await datasetRecord(form.datasetId)
  const geometry = dataset.fields.find(
    (field) =>
      field.type === 'geometry' && form.definition.fields.some((item) => item.key === field.key),
  )
  if (!geometry) return rows
  const approx = form.definition.auto.approxLocation
  const territoryKey = dataset.territoryField
  const index = territoryKey ? await territoryIndex() : null
  return rows.map((values) => {
    if (!isBlank(values[geometry.key])) return approx ? { ...values, [approx]: false } : values
    const raw = territoryKey ? values[territoryKey] : null
    const id =
      typeof raw === 'string' && index ? (index.byId.has(raw) ? raw : index.resolve(raw)) : null
    const centroid = id && id !== 'ambiguous' ? index?.byId.get(id)?.centroid : null
    if (!centroid) return values
    return {
      ...values,
      [geometry.key]: { type: 'Point', coordinates: [centroid.lon, centroid.lat] },
      ...(approx ? { [approx]: true } : {}),
    }
  })
}

export const SubmissionService = {
  /** Отправка периода: существующая или новый черновик. */
  async open(
    ctx: UserCtx,
    formId: string,
    input: { periodKey: string; subject: FormSubject },
  ): Promise<FormSubmission> {
    await authorize(ctx, 'view', formId)
    const form = await FormService.require(db(), formId)
    const manage = await authorize(ctx, 'manage', formId, { soft: true })
    if (!manage.allowed && !maySubmit(ctx, form, input.subject)) {
      throw errors.forbidden('Сдавать сводку за это подразделение может только назначенный')
    }
    const assigned = form.definition.assignments.some(
      (item) => item.kind === input.subject.kind && item.id === input.subject.id,
    )
    if (!assigned) throw errors.validation('Это назначение форме не задано')

    const period = await periodByKey(form, input.periodKey)
    const dueAt = await dueFor(form, period)
    const id = newId()
    await db()
      .insert(formSubmissions)
      .values({
        id,
        formId,
        periodKey: period.key,
        periodStart: period.start,
        periodEnd: period.end,
        dueAt: dueAt.toISOString(),
        subjectKind: input.subject.kind,
        subjectId: input.subject.id,
        status: 'draft',
        values: {},
      })
      .onConflictDoNothing()
    const [row] = await db()
      .select()
      .from(formSubmissions)
      .where(
        and(
          eq(formSubmissions.formId, formId),
          eq(formSubmissions.periodKey, period.key),
          eq(formSubmissions.subjectKind, input.subject.kind),
          eq(formSubmissions.subjectId, input.subject.id),
        ),
      )
      .limit(1)
    if (!row) throw errors.internal('Отправка не создана')
    return view(ctx, form, row as SubmissionRow, manage.allowed)
  },

  async get(ctx: UserCtx, submissionId: string): Promise<FormSubmission> {
    const row = await loadSubmission(db(), submissionId)
    await authorize(ctx, 'view', row.formId)
    const form = await FormService.require(db(), row.formId)
    const manage = await authorize(ctx, 'manage', row.formId, { soft: true })
    return view(ctx, form, row, manage.allowed)
  },

  /** Черновик: значения (у табличной формы — строки) сохраняются без записи в датасет. */
  async save(
    ctx: UserCtx,
    submissionId: string,
    input: FormSubmissionSaveInput,
  ): Promise<FormSubmission> {
    const row = await loadSubmission(db(), submissionId)
    await authorize(ctx, 'view', row.formId)
    const form = await FormService.require(db(), row.formId)
    if (!maySubmit(ctx, form, { kind: row.subjectKind, id: row.subjectId } as FormSubject)) {
      throw errors.forbidden('Заполнять сводку может только назначенный')
    }
    if (!OPEN_STATUSES.includes(row.status as FormSubmissionStatus)) {
      throw errors.conflict('Сводка уже сдана')
    }
    const patch =
      form.definition.layout === 'table' ? { rows: tableRows(input) } : { values: input.values }
    await db()
      .update(formSubmissions)
      .set({ ...patch, authorId: ctx.userId, updatedAt: sql`now()` })
      .where(eq(formSubmissions.id, submissionId))
    return SubmissionService.get(ctx, submissionId)
  },

  /**
   * Сдача: значения проверяются и пишутся строкой датасета с `_import_id`
   * отправки; повторная сдача после возврата правит ту же строку. Табличная
   * форма (ADR-0129) пишет строки одной записью, а повторная сдача заменяет
   * строки прежней сдачи новыми; пустая таблица — «записей не было».
   */
  async submit(
    ctx: UserCtx,
    submissionId: string,
    input: FormSubmissionSaveInput,
  ): Promise<FormSubmission> {
    const current = await loadSubmission(db(), submissionId)
    await authorize(ctx, 'view', current.formId)
    const form = await FormService.require(db(), current.formId)
    const subject = { kind: current.subjectKind, id: current.subjectId } as FormSubject
    if (!maySubmit(ctx, form, subject)) {
      throw errors.forbidden('Сдавать сводку может только назначенный')
    }
    if (!OPEN_STATUSES.includes(current.status as FormSubmissionStatus)) {
      throw errors.conflict('Сводка уже сдана')
    }
    const table = form.definition.layout === 'table'
    const keys = form.definition.fields.map((item) => item.key)
    let entered: Array<Record<string, unknown>>
    if (table) {
      const check = checkTableRows(form.definition, tableRows(input))
      if (!check.ok) throw errors.validation(check.message)
      entered = check.rows
    } else {
      for (const field of form.definition.fields) {
        if (field.required && isBlank(input.values[field.key])) {
          throw errors.validation(`Поле «${field.key}» обязательно`)
        }
      }
      entered = [pickFields(input.values, keys)]
    }
    const writer = await writerCtx(form)
    const auto = await autoValues(form, current, ctx.userId)
    const payloads = (await located(form, entered)).map((values) => ({ ...values, ...auto }))
    const resubmitted = current.status === 'returned' && (table || current.rowId !== null)

    await db().transaction(async (tx) => {
      const [locked] = await tx
        .select({
          status: formSubmissions.status,
          rowId: formSubmissions.rowId,
          rowIds: formSubmissions.rowIds,
        })
        .from(formSubmissions)
        .where(eq(formSubmissions.id, submissionId))
        .for('update')
      if (!locked || !OPEN_STATUSES.includes(locked.status as FormSubmissionStatus)) {
        throw errors.conflict('Сводка уже сдана')
      }
      let rowId: string | null = locked.rowId
      let rowIds: string[]
      if (table) {
        // Возвращённая сводка сдаётся заново целиком: строки прежней сдачи
        // уходят (с историей), новые помечаются той же отправкой
        await DatasetRows.removeMany(tx, writer, form.datasetId, locked.rowIds)
        const inserted = await DatasetRows.insertMany(tx, writer, form.datasetId, payloads, {
          importId: submissionId,
        })
        rowIds = inserted.map((row) => row._id)
        rowId = null
      } else if (rowId) {
        const existing = await DatasetQueries.row(writer, form.datasetId, rowId)
        const updated = await DatasetRows.update(
          tx,
          writer,
          form.datasetId,
          rowId,
          { ver: existing._ver, values: payloads[0] ?? {} },
          { importId: submissionId },
        )
        rowId = updated._id
        rowIds = [rowId]
      } else {
        const inserted = await DatasetRows.insert(tx, writer, form.datasetId, payloads[0] ?? {}, {
          importId: submissionId,
        })
        rowId = inserted._id
        rowIds = [rowId]
      }
      const review = form.definition.review.enabled
      await tx
        .update(formSubmissions)
        .set({
          ...(table ? { rows: entered } : { values: input.values }),
          rowId,
          rowIds,
          status: review ? 'submitted' : 'accepted',
          authorId: ctx.userId,
          submittedAt: sql`now()`,
          ...(review ? {} : { reviewedAt: sql`now()`, reviewerId: null }),
          comment: null,
          updatedAt: sql`now()`,
        })
        .where(eq(formSubmissions.id, submissionId))
      const object = await objectRef(tx, form.id)
      await publishEvent(tx, ctx, {
        type: 'form.submitted',
        object,
        payload: {
          submissionId,
          periodKey: current.periodKey,
          subjectKind: subject.kind,
          subjectId: subject.id,
          rowId,
          rowIds,
          rowCount: rowIds.length,
          resubmitted,
        },
      })
      await FormInbox.closeSubmit(tx, ctx, submissionId)
      if (review) {
        await FormInbox.review(
          tx,
          ctx,
          form,
          { id: submissionId, periodKey: current.periodKey, dueAt: current.dueAt },
          subject,
        )
      } else {
        await publishEvent(tx, ctx, {
          type: 'form.accepted',
          object,
          payload: {
            submissionId,
            periodKey: current.periodKey,
            subjectKind: subject.kind,
            subjectId: subject.id,
            authorId: ctx.userId,
          },
        })
      }
    })
    return SubmissionService.get(ctx, submissionId)
  },

  /** Приёмка: принять или вернуть с комментарием. */
  async review(
    ctx: UserCtx,
    submissionId: string,
    input: FormReviewInput,
  ): Promise<FormSubmission> {
    const current = await loadSubmission(db(), submissionId)
    const form = await FormService.require(db(), current.formId)
    const manage = await authorize(ctx, 'manage', current.formId, { soft: true })
    if (!manage.allowed && !form.reviewers.includes(ctx.userId)) {
      await authorize(ctx, 'manage', current.formId)
    }
    if (current.status !== 'submitted') throw errors.conflict('Сводка не на приёмке')
    if (input.decision === 'return' && !input.comment?.trim()) {
      throw errors.validation('Возврат сводки требует комментария')
    }
    const subject = { kind: current.subjectKind, id: current.subjectId } as FormSubject

    await db().transaction(async (tx) => {
      await tx
        .update(formSubmissions)
        .set({
          status: input.decision === 'accept' ? 'accepted' : 'returned',
          reviewerId: ctx.userId,
          reviewedAt: sql`now()`,
          comment: input.comment?.trim() || null,
          updatedAt: sql`now()`,
        })
        .where(eq(formSubmissions.id, submissionId))
      const object = await objectRef(tx, form.id)
      await FormInbox.closeReview(tx, ctx, submissionId)
      if (input.decision === 'accept') {
        await publishEvent(tx, ctx, {
          type: 'form.accepted',
          object,
          payload: {
            submissionId,
            periodKey: current.periodKey,
            subjectKind: subject.kind,
            subjectId: subject.id,
            authorId: current.authorId,
          },
        })
      } else {
        await publishEvent(tx, ctx, {
          type: 'form.returned',
          object,
          payload: {
            submissionId,
            periodKey: current.periodKey,
            subjectKind: subject.kind,
            subjectId: subject.id,
            authorId: current.authorId,
            comment: input.comment?.trim() ?? '',
          },
        })
        await FormInbox.submit(
          tx,
          ctx,
          form,
          { id: submissionId, periodKey: current.periodKey, dueAt: current.dueAt },
          subject,
        )
      }
    })
    return SubmissionService.get(ctx, submissionId)
  },
}

/** Отправки формы за набор периодов — для матрицы контроля. */
export async function submissionsOf(
  formId: string,
  periodKeys: readonly string[],
): Promise<SubmissionRow[]> {
  if (periodKeys.length === 0) return []
  const rows = await db()
    .select()
    .from(formSubmissions)
    .where(
      and(eq(formSubmissions.formId, formId), inArray(formSubmissions.periodKey, [...periodKeys])),
    )
  return rows as SubmissionRow[]
}
