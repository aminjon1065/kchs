import type {
  ControlBucket,
  ControlCounts,
  ControlList,
  ControlListItem,
  ControlListQuery,
  ControlMetricKey,
  ControlQuery,
  ControlReport,
  ControlRow,
  ControlState,
  ControlWeek,
  FilterNode,
  LangText,
  Locale,
  OrgUnit,
  QueryResult,
  QuerySpec,
  TaskStatus,
} from '@kchs/contracts'
import { CONTROL_METRIC_KEYS } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { addDays, localDate, startOfLocalDay } from '~/kernel/business-calendar/working-days.js'
import { DatasetQueries } from '~/modules/data/public.js'
import { OrgService } from '~/modules/identity/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { refsOf } from './task-core.js'

/** Источник запросов контроля — системный датасет «Поручения» с правами смотрящего. */
const SOURCE = { kind: 'system', name: 'instructions' } as const

/** Сколько недель динамики без периода: 8 прошедших, текущая и 3 следующие. */
const WEEKS_BACK = 8
const WEEKS_AHEAD = 3

/** Срок сегодня — в поясе смотрящего. */
const DUE_TODAY: FilterNode = {
  field: 'due_at',
  op: 'relative',
  value: { unit: 'day', from: 0, to: 0 },
}

/** Условие каждого состояния над полями системного датасета. */
const STATE_FILTERS: Record<ControlState, FilterNode> = {
  on_track: {
    and: [{ field: 'state', op: 'eq', value: 'open' }, { not: DUE_TODAY }],
  },
  due_today: { and: [{ field: 'state', op: 'eq', value: 'open' }, DUE_TODAY] },
  overdue: { field: 'state', op: 'eq', value: 'overdue' },
  done_on_time: { field: 'state', op: 'eq', value: 'done_on_time' },
  done_late: { field: 'state', op: 'eq', value: 'done_late' },
}

const BUCKET_FILTERS: Record<ControlBucket, FilterNode | null> = {
  ...STATE_FILTERS,
  extended: { field: 'extended', op: 'is_true' },
  total: null,
}

const COUNT_ALIASES: Array<[keyof ControlCounts, ControlBucket]> = [
  ['onTrack', 'on_track'],
  ['dueToday', 'due_today'],
  ['overdue', 'overdue'],
  ['doneOnTime', 'done_on_time'],
  ['doneLate', 'done_late'],
  ['extended', 'extended'],
  ['total', 'total'],
]

const and_ = (nodes: FilterNode[]): FilterNode | null =>
  nodes.length === 0 ? null : nodes.length === 1 ? (nodes[0] as FilterNode) : { and: nodes }

/** Подразделения установки: название на языке смотрящего, путь, потомки. */
interface Units {
  byId: Map<string, OrgUnit>
  name: (id: string) => string | null
  path: (id: string) => string[]
  subtree: (id: string) => string[]
}

async function loadUnits(locale: Locale): Promise<Units> {
  const tree = await OrgService.tree()
  const byId = new Map(tree.map((unit) => [unit.id, unit]))
  const children = new Map<string, string[]>()
  for (const unit of tree) {
    if (!unit.parentId) continue
    children.set(unit.parentId, [...(children.get(unit.parentId) ?? []), unit.id])
  }
  const label = (text: LangText) => text[locale] ?? text.ru
  return {
    byId,
    name: (id) => {
      const unit = byId.get(id)
      return unit ? label(unit.name) : null
    },
    path: (id) => {
      const names: string[] = []
      let current = byId.get(id)?.parentId ?? null
      for (let guard = 0; current && guard < 50; guard++) {
        const unit = byId.get(current)
        if (!unit) break
        names.unshift(label(unit.name))
        current = unit.parentId
      }
      return names
    },
    subtree: (id) => {
      const result: string[] = []
      const stack = [id]
      while (stack.length > 0) {
        const next = stack.pop() as string
        result.push(next)
        stack.push(...(children.get(next) ?? []))
      }
      return result
    },
  }
}

/** Условия фильтров экрана «Контроль» над полями системного датасета. */
function scopeOf(ctx: UserCtx, query: ControlQuery, units: Units): FilterNode[] {
  const nodes: FilterNode[] = [{ field: 'state', op: 'neq', value: 'cancelled' }]
  if (!query.parts) nodes.push({ field: 'is_part', op: 'is_false' })
  if (query.unitId) nodes.push({ field: 'unit', op: 'in', value: units.subtree(query.unitId) })
  if (query.assigneeId) nodes.push({ field: 'assignee', op: 'eq', value: query.assigneeId })
  if (query.controllerId) nodes.push({ field: 'controller', op: 'eq', value: query.controllerId })
  if (query.authorId) nodes.push({ field: 'author', op: 'eq', value: query.authorId })
  if (query.from) {
    nodes.push({
      field: 'due_at',
      op: 'gte',
      value: startOfLocalDay(query.from, ctx.timezone).toISOString(),
    })
  }
  if (query.to) {
    nodes.push({
      field: 'due_at',
      op: 'lt',
      value: startOfLocalDay(addDays(query.to, 1), ctx.timezone).toISOString(),
    })
  }
  if (query.source !== 'any') nodes.push({ field: 'source_kind', op: 'eq', value: query.source })
  return nodes
}

function spec(steps: unknown[]): QuerySpec {
  return { version: 1, source: SOURCE, steps } as unknown as QuerySpec
}

/** Строки результата запроса — объектами по именам полей. */
function records(result: QueryResult): Array<Record<string, unknown>> {
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
  )
}

const count = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

function countsOf(record: Record<string, unknown>): ControlCounts {
  return Object.fromEntries(
    COUNT_ALIASES.map(([key, bucket]) => [key, count(record[bucket])]),
  ) as unknown as ControlCounts
}

const measures = () =>
  COUNT_ALIASES.map(([, bucket]) => {
    const filter = BUCKET_FILTERS[bucket]
    return { alias: bucket, agg: 'count', ...(filter ? { filter } : {}) }
  })

const EMPTY_COUNTS: ControlCounts = {
  onTrack: 0,
  dueToday: 0,
  overdue: 0,
  doneOnTime: 0,
  doneLate: 0,
  extended: 0,
  total: 0,
}

/** Понедельник недели дня `day`. */
function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
  return addDays(day, -((dow + 6) % 7))
}

/**
 * Контроль исполнения (08-documents.md §7, 03-screens.md §12, ADR-0082):
 * матрица «подразделения × состояния», итоги, динамика по неделям срока,
 * список по ячейке — запросами к системному датасету «Поручения» с правами
 * смотрящего; руководитель видит поручения подчинённых, контролёр — свои.
 */
export const ControlService = {
  async report(ctx: UserCtx, query: ControlQuery): Promise<ControlReport> {
    const units = await loadUnits(ctx.locale)
    const scope = scopeOf(ctx, query, units)
    const where = and_(scope)
    const filter = where ? [{ type: 'filter', where }] : []

    const today = localDate(new Date(), ctx.timezone)
    const firstWeek = query.from ? mondayOf(query.from) : addDays(mondayOf(today), -7 * WEEKS_BACK)
    const lastWeek = query.to ? mondayOf(query.to) : addDays(mondayOf(today), 7 * WEEKS_AHEAD)
    const weekScope = and_([
      ...scope,
      { field: 'due_at', op: 'gte', value: startOfLocalDay(firstWeek, ctx.timezone).toISOString() },
      {
        field: 'due_at',
        op: 'lt',
        value: startOfLocalDay(addDays(lastWeek, 7), ctx.timezone).toISOString(),
      },
    ])

    const [matrix, dynamics, metrics] = await Promise.all([
      DatasetQueries.run(
        ctx,
        spec([
          ...filter,
          { type: 'aggregate', groupBy: [{ field: 'unit' }], measures: measures() },
        ]),
        { maxRows: null },
      ),
      DatasetQueries.run(
        ctx,
        spec([
          ...(weekScope ? [{ type: 'filter', where: weekScope }] : []),
          {
            type: 'aggregate',
            groupBy: [{ field: 'due_at', bucket: 'week', alias: 'week' }],
            measures: [
              { alias: 'open', agg: 'count', filter: { field: 'state', op: 'eq', value: 'open' } },
              { alias: 'overdue', agg: 'count', filter: STATE_FILTERS.overdue },
              { alias: 'done_on_time', agg: 'count', filter: STATE_FILTERS.done_on_time },
              { alias: 'done_late', agg: 'count', filter: STATE_FILTERS.done_late },
            ],
          },
        ]),
        { maxRows: null },
      ),
      controlMetrics(ctx),
    ])

    const rows: ControlRow[] = records(matrix)
      .map((record) => {
        const unitId = (record.unit as string | null) ?? null
        return {
          unitId,
          unitName: unitId ? units.name(unitId) : null,
          unitPath: unitId ? units.path(unitId) : [],
          counts: countsOf(record),
        }
      })
      .filter((row) => row.counts.total > 0)
      .sort((a, b) => {
        // Без подразделения — в конце; остальные — по пути в оргструктуре
        if (!a.unitId) return 1
        if (!b.unitId) return -1
        const left = [...a.unitPath, a.unitName ?? ''].join(' › ')
        const right = [...b.unitPath, b.unitName ?? ''].join(' › ')
        return left.localeCompare(right, ctx.locale)
      })

    const totals = rows.reduce<ControlCounts>(
      (sum, row) =>
        Object.fromEntries(
          COUNT_ALIASES.map(([key]) => [key, sum[key] + row.counts[key]]),
        ) as unknown as ControlCounts,
      { ...EMPTY_COUNTS },
    )
    const closed = totals.doneOnTime + totals.doneLate

    const byWeek = new Map(
      records(dynamics).map((record) => [
        localDate(new Date(String(record.week)), ctx.timezone),
        record,
      ]),
    )
    const weeks: ControlWeek[] = []
    for (let week = firstWeek; week <= lastWeek; week = addDays(week, 7)) {
      const record = byWeek.get(week) ?? {}
      weeks.push({
        week,
        onTrack: count(record.open),
        overdue: count(record.overdue),
        doneOnTime: count(record.done_on_time),
        doneLate: count(record.done_late),
      })
      if (weeks.length > 60) break
    }

    return {
      rows,
      totals,
      onTimeRate: closed > 0 ? totals.doneOnTime / closed : null,
      weeks,
      metrics,
      generatedAt: new Date().toISOString(),
    }
  },

  /** Поручения ячейки матрицы (или всего столбца): переход по числу-ссылке. */
  async list(ctx: UserCtx, query: ControlListQuery): Promise<ControlList> {
    const units = await loadUnits(ctx.locale)
    const nodes = scopeOf(ctx, query, units)
    const bucket = BUCKET_FILTERS[query.bucket]
    if (bucket) nodes.push(bucket)
    if (query.row === 'none') nodes.push({ field: 'unit', op: 'is_empty' })
    else if (query.row) nodes.push({ field: 'unit', op: 'eq', value: query.row })
    const where = and_(nodes)
    const filter = where ? [{ type: 'filter', where }] : []

    const [page, counted] = await Promise.all([
      DatasetQueries.run(
        ctx,
        spec([
          ...filter,
          {
            type: 'select',
            fields: [
              'id',
              'key',
              'title',
              'status',
              'state',
              'assignee',
              'author',
              'controller',
              'unit',
              'due_at',
              'completed_at',
              'extensions',
              'is_part',
              'days_late',
            ],
          },
          {
            type: 'sort',
            by: [
              { field: 'due_at', dir: 'asc', nulls: 'last' },
              { field: 'key', dir: 'asc' },
            ],
          },
          { type: 'limit', limit: query.limit, offset: 0 },
        ]),
      ),
      DatasetQueries.run(
        ctx,
        spec([
          ...filter,
          { type: 'aggregate', groupBy: [], measures: [{ alias: 'n', agg: 'count' }] },
        ]),
      ),
    ])
    const rows = records(page)
    const people = await refsOf(
      rows.flatMap((row) => [row.assignee, row.author, row.controller] as Array<string | null>),
    )
    const ref = (id: unknown) => (typeof id === 'string' ? (people.get(id) ?? null) : null)
    const today = localDate(new Date(), ctx.timezone)
    const items: ControlListItem[] = rows.map((row) => {
      const dueAt = (row.due_at as string | null) ?? null
      const state = row.state as string
      const unitId = (row.unit as string | null) ?? null
      return {
        id: String(row.id),
        key: String(row.key),
        title: String(row.title ?? ''),
        status: row.status as TaskStatus,
        state: (state === 'open'
          ? dueAt && localDate(new Date(dueAt), ctx.timezone) === today
            ? 'due_today'
            : 'on_track'
          : state) as ControlState,
        assignee: ref(row.assignee),
        author: ref(row.author),
        controller: ref(row.controller),
        unitId,
        unitName: unitId ? units.name(unitId) : null,
        dueAt,
        completedAt: (row.completed_at as string | null) ?? null,
        extensions: count(row.extensions),
        isPart: row.is_part === true,
        daysLate:
          row.days_late === null || row.days_late === undefined ? null : count(row.days_late),
      }
    })
    return { items, total: count(records(counted)[0]?.n) }
  },
}

/** Показатели контроля, заведённые на установке и видимые смотрящему (`meta.systemKey`). */
async function controlMetrics(ctx: UserCtx): Promise<Array<{ key: ControlMetricKey; id: string }>> {
  const rows = await db()
    .select({ id: objects.id, key: sql<string>`${objects.meta}->>'systemKey'` })
    .from(objects)
    .where(
      and(
        eq(objects.type, 'metric'),
        sql`${objects.deletedAt} IS NULL`,
        inArray(sql`${objects.meta}->>'systemKey'`, [...CONTROL_METRIC_KEYS]),
        visibleObjectsSql(ctx, 'metric'),
      ),
    )
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    if (seen.has(row.key)) return []
    seen.add(row.key)
    return [{ key: row.key as ControlMetricKey, id: row.id }]
  })
}
