import { DashboardCreateInput, type FilterNode, MetricCreateInput } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { Dashboards, Metrics } from '~/modules/data/public.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'

/** Показатели канцелярии (08-documents.md §14, ADR-0086) — ключи `meta.systemKey`. */
export const OFFICE_METRIC_KEYS = [
  'documents.registered',
  'documents.overdue_on_control',
  'documents.overdue_share',
] as const
export type OfficeMetricKey = (typeof OFFICE_METRIC_KEYS)[number]

export const OFFICE_DASHBOARD_KEY = 'documents.office'

const ON_CONTROL_OVERDUE: FilterNode = {
  and: [
    { field: 'on_control', op: 'is_true' },
    { field: 'overdue', op: 'is_true' },
  ],
}

/**
 * Обычные показатели над системным датасетом «Документы»: права смотрящего
 * применяет сам датасет (ADR-0080), пороги и сравнение — как у любого показателя.
 */
const METRICS: Record<OfficeMetricKey, Record<string, unknown>> = {
  'documents.registered': {
    name: 'Зарегистрировано документов',
    description: 'Документы, зарегистрированные в журналах за период',
    systemSource: 'documents',
    definition: {
      measure: { agg: 'count' },
      filter: { field: 'reg_date', op: 'not_empty' },
      timeField: 'reg_date',
      dimensions: ['type_name', 'journal_name', 'direction', 'unit'],
      period: { unit: 'month', from: 0, to: 0 },
      comparison: 'previous_period',
    },
    format: { precision: 0 },
    direction: 'neutral',
  },
  'documents.overdue_on_control': {
    name: 'Просрочено на контроле',
    description: 'Открытые документы на контроле, срок исполнения которых прошёл',
    systemSource: 'documents',
    definition: {
      measure: { agg: 'count' },
      filter: ON_CONTROL_OVERDUE,
      timeField: 'deadline',
      dimensions: ['unit', 'responsible', 'controller', 'type_name'],
      period: null,
      comparison: 'none',
    },
    format: { precision: 0 },
    direction: 'down',
    thresholds: [
      { value: 1, status: 'warning' },
      { value: 10, status: 'danger' },
    ],
  },
  'documents.overdue_share': {
    name: 'Доля просроченных на контроле',
    description: 'Часть открытых документов на контроле, срок которых прошёл',
    systemSource: 'documents',
    definition: {
      // `overdue_score` — 100/0 только у открытых документов на контроле
      measure: { agg: 'avg', field: 'overdue_score' },
      filter: null,
      timeField: 'deadline',
      dimensions: ['unit', 'responsible', 'type_name'],
      period: null,
      comparison: 'none',
    },
    format: { precision: 0, scale: 'percent' },
    direction: 'down',
    thresholds: [
      { value: 0, status: 'success' },
      { value: 10, status: 'warning' },
      { value: 25, status: 'danger' },
    ],
  },
}

const SOURCE = { kind: 'system', name: 'documents' } as const
const query = (steps: unknown[]) => ({ version: 1, source: SOURCE, steps })
const REGISTERED: FilterNode = { field: 'reg_date', op: 'not_empty' }

/** Дашборд «Канцелярия»: объём регистрации, просрочка на контроле, нагрузка, журналы. */
function officeSpec(metricIds: Record<OfficeMetricKey, string>) {
  const period = { period: 'reg_date', unit: 'unit' }
  return {
    filters: [
      {
        id: 'period',
        kind: 'period',
        label: { ru: 'Период регистрации', tg: 'Давраи бақайдгирӣ', en: 'Registration period' },
        default: { unit: 'month', from: -11, to: 0 },
      },
      { id: 'unit', kind: 'unit', label: { ru: 'Подразделение', tg: 'Воҳид', en: 'Unit' } },
    ],
    tiles: [
      {
        id: 'registered',
        kind: 'metric',
        metricId: metricIds['documents.registered'],
        filterBindings: { unit: 'unit' },
        x: 0,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'overdue',
        kind: 'metric',
        metricId: metricIds['documents.overdue_on_control'],
        filterBindings: { unit: 'unit' },
        x: 4,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'overdue_share',
        kind: 'metric',
        metricId: metricIds['documents.overdue_share'],
        filterBindings: { unit: 'unit' },
        x: 8,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'months',
        kind: 'chart',
        title: 'Регистрация по месяцам',
        filterBindings: period,
        spec: {
          version: 1,
          type: 'bar',
          data: {
            query: query([
              { type: 'filter', where: REGISTERED },
              {
                type: 'aggregate',
                groupBy: [
                  { field: 'reg_date', bucket: 'month', alias: 'month' },
                  { field: 'type_name', alias: 'type' },
                ],
                measures: [{ alias: 'documents', agg: 'count' }],
              },
              { type: 'sort', by: [{ field: 'month', dir: 'asc' }] },
            ]),
          },
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'documents', type: 'quantitative' }],
            color: { field: 'type', type: 'nominal' },
          },
          options: { stacked: true },
        },
        x: 0,
        y: 2,
        w: 8,
        h: 5,
      },
      {
        id: 'types',
        kind: 'chart',
        title: 'По типам документов',
        filterBindings: period,
        spec: {
          version: 1,
          type: 'bar',
          data: {
            query: query([
              { type: 'filter', where: REGISTERED },
              {
                type: 'aggregate',
                groupBy: [{ field: 'type_name', alias: 'type' }],
                measures: [{ alias: 'documents', agg: 'count' }],
              },
              { type: 'sort', by: [{ field: 'documents', dir: 'desc' }] },
              { type: 'limit', limit: 12 },
            ]),
          },
          encoding: {
            x: { field: 'type', type: 'nominal' },
            y: [{ field: 'documents', type: 'quantitative' }],
          },
        },
        x: 8,
        y: 2,
        w: 4,
        h: 5,
      },
      {
        id: 'load',
        kind: 'chart',
        title: 'Нагрузка на исполнителей: открытые документы',
        filterBindings: { unit: 'unit' },
        spec: {
          version: 1,
          type: 'bar',
          data: {
            query: query([
              {
                type: 'filter',
                where: {
                  and: [
                    { field: 'closed', op: 'is_false' },
                    { field: 'responsible', op: 'not_empty' },
                  ],
                },
              },
              {
                type: 'aggregate',
                groupBy: [{ field: 'responsible', alias: 'responsible' }],
                measures: [
                  { alias: 'documents', agg: 'count' },
                  { alias: 'overdue', agg: 'count', filter: { field: 'overdue', op: 'is_true' } },
                ],
              },
              { type: 'sort', by: [{ field: 'documents', dir: 'desc' }] },
              { type: 'limit', limit: 15 },
            ]),
          },
          encoding: {
            x: { field: 'responsible', type: 'nominal' },
            y: [
              { field: 'documents', type: 'quantitative' },
              { field: 'overdue', type: 'quantitative' },
            ],
          },
        },
        x: 0,
        y: 7,
        w: 6,
        h: 5,
      },
      {
        id: 'journals',
        kind: 'chart',
        title: 'Движение по журналам',
        filterBindings: period,
        spec: {
          version: 1,
          type: 'line',
          data: {
            query: query([
              { type: 'filter', where: REGISTERED },
              {
                type: 'aggregate',
                groupBy: [
                  { field: 'reg_date', bucket: 'month', alias: 'month' },
                  { field: 'journal_name', alias: 'journal' },
                ],
                measures: [{ alias: 'documents', agg: 'count' }],
              },
              { type: 'sort', by: [{ field: 'month', dir: 'asc' }] },
            ]),
          },
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'documents', type: 'quantitative' }],
            color: { field: 'journal', type: 'nominal' },
          },
        },
        x: 6,
        y: 7,
        w: 6,
        h: 5,
      },
    ],
  }
}

/** Заведённые объекты канцелярии (не в корзине) по ключу `meta.systemKey`. */
async function existing(executor: Executor, type: 'metric' | 'dashboard', keys: string[]) {
  return executor
    .select({ id: objects.id, key: sql<string>`${objects.meta}->>'systemKey'` })
    .from(objects)
    .where(
      and(
        eq(objects.type, type),
        sql`${objects.deletedAt} IS NULL`,
        inArray(sql`${objects.meta}->>'systemKey'`, keys),
      ),
    )
}

/**
 * Показатели и дашборд «Канцелярия» (08-documents.md §14) в пространстве —
 * идемпотентно по `systemKey`: сид демо-стенда и повторные запуски не заводят
 * их дважды. Возвращает id дашборда.
 */
export async function ensureOfficeDashboard(
  tx: Executor,
  ctx: Ctx,
  spaceId: string,
): Promise<{ dashboardId: string; created: string[] }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('documents:office-dashboard'))`)
  const created: string[] = []
  const metricIds = new Map(
    (await existing(tx, 'metric', [...OFFICE_METRIC_KEYS])).map((row) => [row.key, row.id]),
  )
  for (const key of OFFICE_METRIC_KEYS) {
    if (metricIds.has(key)) continue
    const id = await Metrics.create(
      tx,
      ctx,
      MetricCreateInput.parse({ ...METRICS[key], spaceId }),
      { systemKey: key },
    )
    metricIds.set(key, id)
    created.push(key)
  }
  const [dashboard] = await existing(tx, 'dashboard', [OFFICE_DASHBOARD_KEY])
  if (dashboard) return { dashboardId: dashboard.id, created }
  const ids = Object.fromEntries(metricIds) as Record<OfficeMetricKey, string>
  const dashboardId = await Dashboards.create(
    tx,
    ctx,
    DashboardCreateInput.parse({ name: 'Канцелярия', spaceId, spec: officeSpec(ids) }),
    { systemKey: OFFICE_DASHBOARD_KEY },
  )
  created.push(OFFICE_DASHBOARD_KEY)
  return { dashboardId, created }
}

/** Дашборд «Канцелярия», если он заведён и виден пользователю, — для навигатора документов. */
export async function officeDashboardId(ctx: UserCtx): Promise<string | null> {
  const [row] = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.type, 'dashboard'),
        sql`${objects.deletedAt} IS NULL`,
        sql`${objects.meta}->>'systemKey' = ${OFFICE_DASHBOARD_KEY}`,
        visibleObjectsSql(ctx, 'dashboard'),
      ),
    )
    .limit(1)
  return row?.id ?? null
}
