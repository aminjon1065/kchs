import { DashboardCreateInput, type FilterNode, MetricCreateInput } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { objects } from '~/kernel/objects/schema.js'
import { Dashboards, Metrics } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor, Tx } from '~/shared/db/client.js'

/**
 * Показатели и дашборд «Интеграции» над системным датасетом «Подключения»
 * (ADR-0206): кто обменивается данными с платформой, каким каналом, сколько и
 * насколько регулярно. Показатель концепт-ноты «не менее двух партнёров на уровнях
 * 0–2» — «Активные подключения». Заводится сидом: модуль интеграций ниже модуля
 * данных по слоям (ADR-0181) и создавать показатели сам не может. Права смотрящего
 * применяет датасет: строки видят те, кто управляет интеграциями.
 */
export const INTEGRATION_METRIC_KEYS = [
  'integrations.active_connections',
  'integrations.requests',
  'integrations.rows',
  'integrations.silent',
  'integrations.completeness',
] as const
type IntegrationMetricKey = (typeof INTEGRATION_METRIC_KEYS)[number]

export const INTEGRATIONS_DASHBOARD_KEY = 'integrations.connections'

const TODAY_ACTIVE: FilterNode = {
  and: [
    { field: 'is_today', op: 'is_true' },
    { field: 'status', op: 'eq', value: 'active' },
  ],
}

const METRICS: Record<IntegrationMetricKey, Record<string, unknown>> = {
  'integrations.active_connections': {
    name: 'Активные подключения',
    description:
      'Подключения с передачами за последние 30 дней: токены, вебхуки, ленты, источники, формы',
    systemSource: 'connections',
    definition: {
      measure: { agg: 'count_distinct', field: 'connection_id' },
      filter: { field: 'active', op: 'is_true' },
      timeField: 'day',
      dimensions: ['channel', 'kind', 'connection'],
      period: { unit: 'day', from: -29, to: 0 },
      comparison: 'previous_period',
    },
    format: { precision: 0 },
    direction: 'up',
    thresholds: [
      { value: 0, status: 'danger' },
      { value: 2, status: 'success' },
    ],
  },
  'integrations.requests': {
    name: 'Запросы и передачи за сутки',
    description: 'Запросы по токенам, входящие вызовы, синхронизации лент и сдачи форм за сегодня',
    systemSource: 'connections',
    definition: {
      measure: { agg: 'sum', field: 'requests' },
      filter: null,
      timeField: 'day',
      dimensions: ['channel', 'connection'],
      period: { unit: 'day', from: 0, to: 0 },
      comparison: 'previous_period',
    },
    format: { precision: 0 },
    direction: 'neutral',
  },
  'integrations.rows': {
    name: 'Строк получено за сутки',
    description: 'Строки, записанные в датасеты по подключениям за сегодня',
    systemSource: 'connections',
    definition: {
      measure: { agg: 'sum', field: 'rows' },
      filter: null,
      timeField: 'day',
      dimensions: ['channel', 'connection'],
      period: { unit: 'day', from: 0, to: 0 },
      comparison: 'previous_period',
    },
    format: { precision: 0 },
    direction: 'neutral',
  },
  'integrations.silent': {
    name: 'Молчат дольше суток',
    description: 'Действующие подключения без передач больше 24 часов или ни разу не передававшие',
    systemSource: 'connections',
    definition: {
      measure: { agg: 'count' },
      filter: {
        and: [...(TODAY_ACTIVE as { and: FilterNode[] }).and, { field: 'stale', op: 'is_true' }],
      },
      timeField: 'day',
      dimensions: ['channel', 'kind', 'connection'],
      period: null,
      comparison: 'none',
    },
    format: { precision: 0 },
    direction: 'down',
    thresholds: [
      { value: 0, status: 'success' },
      { value: 1, status: 'warning' },
      { value: 3, status: 'danger' },
    ],
  },
  'integrations.completeness': {
    name: 'Полнота передач за 30 дней',
    description: 'Средняя доля дней с передачами у действующих подключений',
    systemSource: 'connections',
    definition: {
      measure: { agg: 'avg', field: 'completeness' },
      filter: TODAY_ACTIVE,
      timeField: 'day',
      dimensions: ['channel', 'kind'],
      period: null,
      comparison: 'none',
    },
    format: { precision: 0, scale: 'percent' },
    direction: 'up',
    thresholds: [
      { value: 0, status: 'danger' },
      { value: 50, status: 'warning' },
      { value: 90, status: 'success' },
    ],
  },
}

const SOURCE = { kind: 'system', name: 'connections' } as const
const query = (steps: unknown[]) => ({ version: 1, source: SOURCE, steps })

function metricTile(id: string, metricId: string, x: number) {
  return { id, kind: 'metric', metricId, filterBindings: {}, x, y: 0, w: 3, h: 2 }
}

/** Дашборд «Интеграции»: показатели сверху, объём по дням и каналам, состояние подключений. */
function integrationsSpec(ids: Record<IntegrationMetricKey, string>) {
  return {
    filters: [
      {
        id: 'period',
        kind: 'period',
        label: { ru: 'Период', tg: 'Давра', en: 'Period' },
        default: { unit: 'day', from: -29, to: 0 },
      },
    ],
    tiles: [
      metricTile('active', ids['integrations.active_connections'], 0),
      metricTile('requests', ids['integrations.requests'], 3),
      metricTile('rows', ids['integrations.rows'], 6),
      metricTile('silent', ids['integrations.silent'], 9),
      {
        id: 'daily',
        kind: 'chart',
        title: 'Передачи по дням и каналам',
        filterBindings: { period: 'day' },
        spec: {
          version: 1,
          type: 'bar',
          data: {
            query: query([
              {
                type: 'aggregate',
                groupBy: [
                  { field: 'day', bucket: 'day', alias: 'day' },
                  { field: 'channel', alias: 'channel' },
                ],
                measures: [{ alias: 'requests', agg: 'sum', field: 'requests' }],
              },
              { type: 'sort', by: [{ field: 'day', dir: 'asc' }] },
            ]),
          },
          encoding: {
            x: { field: 'day', type: 'temporal' },
            y: [{ field: 'requests', type: 'quantitative' }],
            color: { field: 'channel', type: 'nominal' },
          },
          options: { stacked: true },
        },
        x: 0,
        y: 2,
        w: 8,
        h: 5,
      },
      {
        id: 'completeness',
        kind: 'metric',
        metricId: ids['integrations.completeness'],
        filterBindings: {},
        x: 8,
        y: 2,
        w: 4,
        h: 2,
      },
      {
        id: 'rows_by_connection',
        kind: 'chart',
        title: 'Строки по подключениям',
        filterBindings: { period: 'day' },
        spec: {
          version: 1,
          type: 'bar',
          data: {
            query: query([
              {
                type: 'aggregate',
                groupBy: [{ field: 'connection', alias: 'connection' }],
                measures: [{ alias: 'rows', agg: 'sum', field: 'rows' }],
              },
              { type: 'sort', by: [{ field: 'rows', dir: 'desc' }] },
              { type: 'limit', limit: 10 },
            ]),
          },
          encoding: {
            x: { field: 'connection', type: 'nominal' },
            y: [{ field: 'rows', type: 'quantitative' }],
          },
        },
        x: 8,
        y: 4,
        w: 4,
        h: 3,
      },
      {
        id: 'state',
        kind: 'chart',
        title: 'Состояние подключений',
        filterBindings: {},
        spec: {
          version: 1,
          type: 'table',
          data: {
            query: query([
              { type: 'filter', where: { field: 'is_today', op: 'is_true' } },
              {
                type: 'select',
                fields: [
                  'connection',
                  'channel',
                  'status',
                  'since',
                  'last_at',
                  'hours_since_last',
                  'completeness',
                  'errors',
                  'last_error',
                ],
              },
              { type: 'sort', by: [{ field: 'hours_since_last', dir: 'desc' }] },
              { type: 'limit', limit: 100 },
            ]),
          },
          encoding: {
            x: { field: 'connection', type: 'nominal' },
            y: [
              { field: 'channel', type: 'nominal' },
              { field: 'status', type: 'nominal' },
              { field: 'since', type: 'temporal' },
              { field: 'last_at', type: 'temporal' },
              { field: 'hours_since_last', type: 'quantitative' },
              { field: 'completeness', type: 'quantitative' },
              { field: 'errors', type: 'quantitative' },
              { field: 'last_error', type: 'nominal' },
            ],
            tooltip: [],
          },
        },
        x: 0,
        y: 7,
        w: 12,
        h: 6,
      },
    ],
  }
}

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
 * Показатели и дашборд «Интеграции» в пространстве — идемпотентно по `systemKey`:
 * повторный сид досоздаёт недостающее и не трогает правки администратора.
 */
export async function ensureIntegrationsDashboard(
  tx: Tx,
  ctx: Ctx,
  spaceId: string,
): Promise<{ dashboardId: string; created: string[] }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('integrations:dashboard'))`)
  const created: string[] = []
  const metricIds = new Map(
    (await existing(tx, 'metric', [...INTEGRATION_METRIC_KEYS])).map((row) => [row.key, row.id]),
  )
  for (const key of INTEGRATION_METRIC_KEYS) {
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
  const [dashboard] = await existing(tx, 'dashboard', [INTEGRATIONS_DASHBOARD_KEY])
  if (dashboard) return { dashboardId: dashboard.id, created }
  const ids = Object.fromEntries(metricIds) as Record<IntegrationMetricKey, string>
  const dashboardId = await Dashboards.create(
    tx,
    ctx,
    DashboardCreateInput.parse({ name: 'Интеграции', spaceId, spec: integrationsSpec(ids) }),
    { systemKey: INTEGRATIONS_DASHBOARD_KEY },
  )
  created.push(INTEGRATIONS_DASHBOARD_KEY)
  return { dashboardId, created }
}
