// Нагрузочный профиль тяжёлых запросов к датасетам масштаба S2: несколько
// аналитиков и дашбордов одновременно на датасете 5 млн строк. В S2 крупные
// агрегаты уходят в колоночный tier (Parquet + DuckDB в движке, ADR-0109) —
// профиль намеренно включает свод по всему периоду, который туда попадает.
//
// Бюджет — 04-verification.md §4: запрос к датасету ≤ 10 млн строк p95 ≤ 2 с.
// Запросы идут мимо кэша (options.cache: false), период и район каждый раз
// свои: замер холодный, как у первого открытия графика.
//
// Запуск — KCHS_PERF_PROFILE=s2-analytics bash infra/perf/run-k6.sh
//   KCHS_PERF_QUERY_RATE=10    запросов в секунду (в профиле S1 — 2)
//   KCHS_PERF_DATASET=<id>     датасет вместо поиска по названию
import { fail } from 'k6'
import {
  ADMIN,
  ADMIN_PASSWORD,
  addDays,
  budgets,
  call,
  INSECURE_TLS,
  must,
  num,
  pick,
  rampingStages,
  randomDay,
  signIn,
  summary,
  text,
} from './lib/kchs.js'

const RATE = num('KCHS_PERF_QUERY_RATE', 10)
const DURATION = text('KCHS_PERF_DURATION', '5m')
/** Меньше строк — не тот масштаб, бюджет на нём ничего не доказывает. */
const MIN_ROWS = 1_000_000

/** Доли запросов: сводки чаще, как на дашбордах; свод по всему периоду реже. */
const WEIGHTS = [
  ['agg_region', 3],
  ['agg_month', 3],
  ['agg_period', 2],
  ['rows_page', 2],
  ['drill', 2],
  ['profile', 1],
]
const OPS = WEIGHTS.map(([op]) => op)

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  scenarios: {
    queries: {
      executor: 'ramping-arrival-rate',
      exec: 'query',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: RATE * 3,
      maxVUs: RATE * 10,
      stages: rampingStages(RATE, DURATION),
    },
  },
  thresholds: {
    ...budgets(Object.fromEntries(OPS.map((op) => [op, 'p(95)<2000']))),
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'max', 'count'],
  setupTimeout: '300s',
}

/** «Происшествия» (самый большой такой датасет) и районы справочника. */
export function prepareAnalytics(session) {
  let datasetId = __ENV.KCHS_PERF_DATASET || null
  if (!datasetId) {
    const items = must(session, 'GET', '/objects?type=dataset&limit=200').json('items')
    let best = null
    for (const item of items.filter((candidate) => candidate.title === 'Происшествия')) {
      const record = must(session, 'GET', `/datasets/${item.id}`).json()
      if (!best || record.rowCount > best.rowCount) best = record
    }
    datasetId = best?.id ?? null
  }
  if (!datasetId) {
    fail('нет датасета «Происшествия» — загрузите демо-датасеты: pnpm db:seed --data=demo')
  }
  const dataset = must(session, 'GET', `/datasets/${datasetId}`).json()
  if (dataset.rowCount < MIN_ROWS) {
    fail(`в «Происшествиях» ${dataset.rowCount} строк — нужен профиль demo`)
  }
  const territories = must(session, 'GET', '/territories').json('items')
  const districts = territories.filter((item) => item.level === 'district').map((item) => item.id)
  if (districts.length === 0) fail('справочник территорий пуст — выполните pnpm db:seed')
  return { session, datasetId, rows: dataset.rowCount, districts }
}

export function setup() {
  return prepareAnalytics(signIn(ADMIN, ADMIN_PASSWORD))
}

function weightedOp() {
  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = Math.random() * total
  for (const [op, weight] of WEIGHTS) {
    roll -= weight
    if (roll < 0) return op
  }
  return WEIGHTS[0][0]
}

function run(data, steps, op) {
  return call(
    data.session,
    'POST',
    '/queries/run',
    {
      spec: {
        version: 1,
        source: { kind: 'dataset', id: data.datasetId },
        steps,
        options: { cache: false },
      },
    },
    op,
  )
}

const byRegion = (measures) => [
  {
    type: 'compute',
    fields: [
      { name: 'region', expr: "territory_level(territory, 'region')" },
      { name: 'region_name', expr: 'territory_name(region)' },
    ],
  },
  { type: 'aggregate', groupBy: [{ field: 'region_name' }], measures },
  { type: 'sort', by: [{ field: 'n', dir: 'desc' }] },
]

export function query(data) {
  const analytics = data.analytics ?? data
  const op = weightedOp()
  if (op === 'agg_region') {
    const from = randomDay(90)
    run(
      analytics,
      [
        {
          type: 'filter',
          where: { field: 'occurred_at', op: 'between', value: [from, addDays(from, 90)] },
        },
        ...byRegion([
          { alias: 'n', agg: 'count' },
          { alias: 'damage', agg: 'sum', field: 'damage' },
        ]),
      ],
      op,
    )
  } else if (op === 'agg_month') {
    const year = pick([2024, 2025, 2026])
    run(
      analytics,
      [
        {
          type: 'filter',
          where: { field: 'occurred_at', op: 'between', value: [`${year}-01-01`, `${year}-12-31`] },
        },
        { type: 'compute', fields: [{ name: 'kind', expr: 'lookup_label(type_code)' }] },
        {
          type: 'aggregate',
          groupBy: [{ field: 'occurred_at', bucket: 'month' }, { field: 'kind' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ],
      op,
    )
  } else if (op === 'agg_period') {
    // Свод по всему периоду без фильтра: в S2 его считает колоночная копия
    run(
      analytics,
      byRegion([
        { alias: 'n', agg: 'count' },
        { alias: 'damage', agg: 'sum', field: 'damage' },
      ]),
      op,
    )
  } else if (op === 'rows_page') {
    const offset = Math.floor(Math.random() * 100) * 100
    call(
      analytics.session,
      'POST',
      `/datasets/${analytics.datasetId}/rows/query`,
      { sort: [{ field: 'occurred_at', dir: 'desc' }], limit: 100, offset, count: offset === 0 },
      op,
    )
  } else if (op === 'drill') {
    const from = randomDay(31)
    run(
      analytics,
      [
        {
          type: 'filter',
          where: {
            and: [
              {
                field: 'territory',
                op: 'within',
                value: { id: pick(analytics.districts), includeChildren: false },
              },
              { field: 'occurred_at', op: 'between', value: [from, addDays(from, 31)] },
            ],
          },
        },
        { type: 'sort', by: [{ field: 'occurred_at', dir: 'asc' }] },
        { type: 'limit', limit: 100, offset: 0 },
      ],
      op,
    )
  } else {
    const field = pick(['damage', 'type_code', 'occurred_at', 'territory'])
    call(
      analytics.session,
      'GET',
      `/datasets/${analytics.datasetId}/fields/${field}/profile`,
      undefined,
      op,
    )
  }
}

export function handleSummary(data) {
  return summary(`запросы к датасету S2: ${RATE} запрос/с, ${DURATION}`, data)
}
