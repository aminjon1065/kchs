import type {
  DatasetRecord,
  FieldDef,
  FormCreateInput,
  FormDefinition,
  FormList,
  FormListQuery,
  FormRecord,
  FormSchema,
  FormUpdateInput,
} from '@kchs/contracts'
import { and, arrayContains, arrayOverlaps, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { datasetRecord } from '~/modules/data/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { formSubmissions, forms, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { resolvePeople } from './assignees.js'

/**
 * Формы сбора данных (06-analytics-engine.md §13, ADR-0103): форма — объект
 * реестра, привязанный к датасету. Схема формы — подмножество полей датасета;
 * скрытые авто-поля заполняются при отправке.
 */

export interface FormRow {
  id: string
  datasetId: string
  definition: FormDefinition
  enabled: boolean
  runAs: string | null
  periodicity: string
  assignedUnits: string[]
  assignedUsers: string[]
  reviewers: string[]
  spaceId: string
  parentId: string | null
  ownerId: string | null
  title: string
  subtitle: string | null
  createdAt: string
  updatedAt: string
}

const selection = {
  id: forms.id,
  datasetId: forms.datasetId,
  definition: forms.definition,
  enabled: forms.enabled,
  runAs: forms.runAs,
  periodicity: forms.periodicity,
  assignedUnits: forms.assignedUnits,
  assignedUsers: forms.assignedUsers,
  reviewers: forms.reviewers,
  spaceId: objects.spaceId,
  parentId: objects.parentId,
  ownerId: objects.ownerId,
  title: objects.title,
  subtitle: objects.subtitle,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

function toRow(row: Record<string, unknown>): FormRow {
  return {
    ...(row as unknown as FormRow),
    definition: row.definition as FormDefinition,
    spaceId: (row.spaceId as string | null) ?? '',
  }
}

/** Поля датасета, доступные форме: те, что хранятся в таблице и правятся. */
function datasetFields(dataset: DatasetRecord): Map<string, FieldDef> {
  return new Map(dataset.fields.map((field) => [field.key, field as FieldDef]))
}

/** Проверка определения: схема формы ⊆ полей датасета, авто-поля не дублируют их. */
async function validate(definition: FormDefinition): Promise<void> {
  const dataset = await datasetRecord(definition.datasetId)
  const fields = datasetFields(dataset)
  const keys = new Set<string>()
  for (const field of definition.fields) {
    if (!fields.has(field.key)) throw errors.validation(`Поля «${field.key}» в датасете нет`)
    if (keys.has(field.key)) throw errors.validation(`Поле «${field.key}» указано дважды`)
    keys.add(field.key)
  }
  for (const [role, key] of Object.entries(definition.auto)) {
    if (!key) continue
    if (!fields.has(key)) throw errors.validation(`Авто-поля «${key}» в датасете нет`)
    if (keys.has(key)) {
      throw errors.validation(`Поле «${key}» нельзя одновременно заполнять вручную и авто-полем`)
    }
    if (role === 'submittedAt') {
      const type = fields.get(key)?.type
      if (type !== 'datetime' && type !== 'date') {
        throw errors.validation('Авто-поле времени отправки — дата или дата со временем')
      }
    }
  }
  if (definition.schedule.periodicity === 'once' && !definition.schedule.dueOn) {
    throw errors.validation('У разовой формы укажите день срока')
  }
  const subjects = new Set(definition.assignments.map((item) => `${item.kind}:${item.id}`))
  if (subjects.size !== definition.assignments.length) {
    throw errors.validation('Назначения повторяются')
  }
}

/** Денормализованные столбцы: назначения и разобранные ответственные. */
async function denormalize(definition: FormDefinition, spaceId: string, ownerId: string | null) {
  const reviewers = definition.review.enabled
    ? await resolvePeople(definition.review.reviewers, { spaceId, authorId: ownerId })
    : []
  return {
    periodicity: definition.schedule.periodicity,
    assignedUnits: definition.assignments
      .filter((item) => item.kind === 'unit')
      .map((item) => item.id),
    assignedUsers: definition.assignments
      .filter((item) => item.kind === 'user')
      .map((item) => item.id),
    reviewers,
  }
}

export const FormService = {
  async load(executor: Executor, id: string): Promise<FormRow | null> {
    const [row] = await executor
      .select(selection)
      .from(forms)
      .innerJoin(objects, eq(objects.id, forms.id))
      .where(and(eq(forms.id, id), isNull(objects.deletedAt)))
      .limit(1)
    return row ? toRow(row) : null
  },

  async require(executor: Executor, id: string): Promise<FormRow> {
    const row = await FormService.load(executor, id)
    if (!row) throw errors.notFound('Форма')
    return row
  },

  async create(tx: Executor, ctx: UserCtx, input: FormCreateInput): Promise<string> {
    await validate(input.definition)
    const object = await ObjectService.create(tx, ctx, {
      type: 'form',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      subtitle: input.description?.trim() || null,
      meta: { enabled: input.enabled, periodicity: input.definition.schedule.periodicity },
    })
    const extra = await denormalize(input.definition, input.spaceId, ctx.userId)
    await tx.insert(forms).values({
      id: object.id,
      datasetId: input.definition.datasetId,
      definition: input.definition,
      enabled: input.enabled,
      runAs: ctx.userId,
      ...extra,
    })
    await LinkService.setDependencies(tx, object.id, [input.definition.datasetId])
    await publishEvent(tx, ctx, {
      type: 'form.created',
      object: { ...object, type: 'form' },
      payload: {
        datasetId: input.definition.datasetId,
        periodicity: input.definition.schedule.periodicity,
      },
    })
    return object.id
  },

  async update(tx: Executor, ctx: UserCtx, id: string, input: FormUpdateInput): Promise<void> {
    const current = await FormService.require(tx, id)
    const changed: string[] = []
    if (input.name !== undefined || input.description !== undefined) {
      await ObjectService.update(tx, ctx, id, {
        ...(input.name !== undefined ? { title: input.name } : {}),
        ...(input.description !== undefined ? { subtitle: input.description?.trim() || null } : {}),
      })
      if (input.name !== undefined) changed.push('name')
      if (input.description !== undefined) changed.push('description')
    }
    if (input.definition) {
      await validate(input.definition)
      const extra = await denormalize(input.definition, current.spaceId, current.ownerId)
      await tx
        .update(forms)
        .set({
          datasetId: input.definition.datasetId,
          definition: input.definition,
          ...extra,
          updatedAt: sql`now()`,
        })
        .where(eq(forms.id, id))
      await LinkService.setDependencies(tx, id, [input.definition.datasetId])
      await ObjectService.update(
        tx,
        ctx,
        id,
        {
          meta: { periodicity: input.definition.schedule.periodicity },
          mergeMeta: true,
        },
        { silent: true },
      )
      changed.push('definition')
    }
    if (changed.length === 0) return
    await publishEvent(tx, ctx, {
      type: 'form.updated',
      object: await objectRef(tx, id),
      payload: { changed },
    })
  },

  async setEnabled(tx: Executor, ctx: UserCtx, id: string, enabled: boolean): Promise<void> {
    const current = await FormService.require(tx, id)
    if (current.enabled === enabled) return
    if (enabled && current.definition.assignments.length === 0) {
      throw errors.validation('У формы нет назначений — сдавать сводку некому')
    }
    await tx.update(forms).set({ enabled, updatedAt: sql`now()` }).where(eq(forms.id, id))
    await ObjectService.update(tx, ctx, id, { meta: { enabled }, mergeMeta: true }, { silent: true })
    await publishEvent(tx, ctx, {
      type: enabled ? 'form.enabled' : 'form.disabled',
      object: await objectRef(tx, id),
      payload: enabled ? { assignments: current.definition.assignments.length } : {},
    })
  },

  async get(ctx: UserCtx, id: string): Promise<FormRecord> {
    await authorize(ctx, 'view', id)
    const row = await FormService.require(db(), id)
    const [manage, dataset] = await Promise.all([
      authorize(ctx, 'manage', id, { soft: true }),
      datasetName(row.datasetId),
    ])
    return {
      id: row.id,
      name: row.title,
      description: row.subtitle,
      spaceId: row.spaceId,
      parentId: row.parentId,
      datasetId: row.datasetId,
      datasetName: dataset,
      definition: row.definition,
      enabled: row.enabled,
      canManage: manage.allowed,
      canSubmit: subjectsFor(ctx, row).length > 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  },

  /**
   * Список форм: только видимые смотрящему (ядро отдаёт доступ через политику
   * типа), с числом назначений и просроченных сдач.
   */
  async list(ctx: UserCtx, query: FormListQuery): Promise<FormList> {
    const conditions = [isNull(objects.deletedAt), eq(objects.type, 'form')]
    if (query.spaceId) conditions.push(eq(objects.spaceId, query.spaceId))
    if (query.datasetId) conditions.push(eq(forms.datasetId, query.datasetId))
    if (query.mine) {
      const mine = [
        arrayContains(forms.assignedUsers, [ctx.userId]),
        ...(ctx.principals.unitIds.length > 0
          ? [arrayOverlaps(forms.assignedUnits, ctx.principals.unitIds)]
          : []),
      ]
      const predicate = mine.length === 1 ? mine[0] : or(...mine)
      if (predicate) conditions.push(predicate)
    }
    const rows = await db()
      .select(selection)
      .from(forms)
      .innerJoin(objects, eq(objects.id, forms.id))
      .where(and(...conditions))
      .orderBy(desc(objects.updatedAt))
      .limit(query.limit)

    const visible: FormRow[] = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'view', row.id, { soft: true })
      if (decision.allowed) visible.push(toRow(row))
    }
    const [overdue, datasets] = await Promise.all([
      overdueCounts(visible.map((row) => row.id)),
      datasetNames(visible.map((row) => row.datasetId)),
    ])
    return {
      items: visible.map((row) => ({
        id: row.id,
        name: row.title,
        spaceId: row.spaceId,
        datasetId: row.datasetId,
        datasetName: datasets.get(row.datasetId) ?? null,
        periodicity: row.definition.schedule.periodicity,
        enabled: row.enabled,
        assignments: row.definition.assignments.length,
        overdue: overdue.get(row.id) ?? 0,
        updatedAt: row.updatedAt,
      })),
    }
  },

  /** Поля экрана заполнения: определения полей датасета в порядке формы. */
  async schema(ctx: UserCtx, id: string): Promise<FormSchema> {
    await authorize(ctx, 'view', id)
    const row = await FormService.require(db(), id)
    const dataset = await datasetRecord(row.datasetId)
    const fields = datasetFields(dataset)
    return {
      formId: id,
      fields: row.definition.fields.map((item, index) => {
        const field = fields.get(item.key)
        if (!field) throw errors.validation(`Поля «${item.key}» в датасете больше нет`)
        return {
          ...field,
          required: item.required,
          readOnly: false,
          order: index,
          ...(item.hint ? { description: item.hint } : {}),
        }
      }),
    }
  },

  /** Поисковый документ формы. */
  async searchable(id: string) {
    const row = await FormService.load(db(), id)
    if (!row) return null
    return {
      parentId: row.parentId,
      type: 'form' as const,
      spaceId: row.spaceId,
      title: row.title,
      body: (row.subtitle ?? '').slice(0, 4000),
      ownerId: row.ownerId,
      updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
      meta: {},
    }
  },
}

/**
 * Назначения, за которые отчитывается пользователь: он сам и подразделения,
 * в которых он состоит. Матрица контроля показывает их строками.
 */
export function subjectsFor(
  ctx: UserCtx,
  row: Pick<FormRow, 'assignedUnits' | 'assignedUsers'>,
): Array<{ kind: 'unit' | 'user'; id: string }> {
  const out: Array<{ kind: 'unit' | 'user'; id: string }> = []
  if (row.assignedUsers.includes(ctx.userId)) out.push({ kind: 'user', id: ctx.userId })
  const units = new Set(ctx.principals.unitIds)
  for (const id of row.assignedUnits) if (units.has(id)) out.push({ kind: 'unit', id })
  return out
}

/** Ссылка на объект формы для события. */
export async function objectRef(executor: Executor, id: string) {
  const [row] = await executor
    .select({ id: objects.id, type: objects.type, spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1)
  if (!row) throw errors.notFound('Форма')
  return row
}

async function overdueCounts(formIds: string[]): Promise<Map<string, number>> {
  if (formIds.length === 0) return new Map()
  const rows = await db()
    .select({ formId: formSubmissions.formId, total: sql<number>`count(*)::int` })
    .from(formSubmissions)
    .where(
      and(
        inArray(formSubmissions.formId, formIds),
        inArray(formSubmissions.status, ['draft', 'returned']),
        sql`${formSubmissions.dueAt} is not null and ${formSubmissions.dueAt} < now()`,
      ),
    )
    .groupBy(formSubmissions.formId)
  return new Map(rows.map((row) => [row.formId, Number(row.total)]))
}

async function datasetNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db()
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .where(inArray(objects.id, unique))
  return new Map(rows.map((row) => [row.id, row.title]))
}

async function datasetName(id: string): Promise<string | null> {
  return (await datasetNames([id])).get(id) ?? null
}
