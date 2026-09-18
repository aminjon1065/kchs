// Нагрузочный профиль запросов к датасету — бюджет 04-verification.md §4: запрос к
// датасету ≤ 10 млн строк (агрегация с фильтром) p95 ≤ 2 с, «k6 на демо-данных».
// Источник — «Происшествия» демо-датасетов (5 млн строк, `pnpm db:seed --data=demo`,
// ADR-0063). Запросы идут мимо кэша (`options.cache: false`), период и район каждый раз
// свои — замер холодный, как у первого открытия графика.
//
// Нагрузка по умолчанию — 2 запроса в секунду вперемешку: сводка по областям за период,
// ряд по месяцам и типам, страница таблицы, детализация до строк района, профиль столбца.
//
// Запуск — KCHS_PERF_PROFILE=data-queries bash infra/perf/run-k6.sh; параметры —
// переменные KCHS_PERF_* (KCHS_PERF_DATASET — идентификатор датасета вместо поиска).
import { check, fail } from 'k6'
import http from 'k6/http'

const API = (__ENV.KCHS_PERF_API || 'http://host.docker.internal:3000/api/v1').replace(/\/$/, '')
const ADMIN = __ENV.KCHS_PERF_ADMIN || 'admin'
const ADMIN_PASSWORD = __ENV.KCHS_PERF_ADMIN_PASSWORD || 'Kchs!Start-2026-7q'
const COOKIE = __ENV.KCHS_PERF_COOKIE || 'kchs_session'
const RATE = Number(__ENV.KCHS_PERF_RATE || 2)
const DURATION = __ENV.KCHS_PERF_DURATION || '2m'
/** Меньше строк — не тот масштаб, бюджет на нём ничего не доказывает. */
const MIN_ROWS = 1_000_000

const QUERY_BUDGET = 'p(95)<2000'
const OPS = ['agg_region', 'agg_month', 'rows_page', 'drill', 'profile']
// Доля запросов: сводки чаще, как на дашбордах
const WEIGHTS = [
  ['agg_region', 3],
  ['agg_month', 3],
  ['rows_page', 2],
  ['drill', 2],
  ['profile', 1],
]

export const options = {
  scenarios: {
    queries: {
      executor: 'constant-arrival-rate',
      exec: 'query',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: {
    ...Object.fromEntries(OPS.map((op) => [`http_req_duration{op:${op}}`, [QUERY_BUDGET]])),
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'max', 'count'],
  setupTimeout: '60s',
}

function signIn() {
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ login: ADMIN, password: ADMIN_PASSWORD }),
    { headers: { 'content-type': 'application/json' }, tags: { op: 'setup' } },
  )
  const token = res.cookies[COOKIE]?.[0]?.value
  const csrf = res.status === 200 ? res.json('csrfToken') : null
  if (!token || !csrf) fail(`вход ${ADMIN}: ${res.status} ${res.body}`)
  return { token, csrf }
}

function call(session, method, path, body, op) {
  const headers = { cookie: `${COOKIE}=${session.token}`, 'x-csrf-token': session.csrf }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = http.request(
    method,
    `${API}${path}`,
    body === undefined ? null : JSON.stringify(body),
    { headers, tags: { op }, timeout: '60s' },
  )
  check(res, { [`${op}: 2xx`]: (r) => r.status >= 200 && r.status < 300 })
  return res
}

/** Демо-датасет «Происшествия» (самый большой с таким названием) и районы справочника. */
export function setup() {
  const session = signIn()
  let datasetId = __ENV.KCHS_PERF_DATASET || null
  if (!datasetId) {
    const items = call(session, 'GET', '/objects?type=dataset&limit=200', undefined, 'setup').json(
      'items',
    )
    let best = null
    for (const item of items.filter((candidate) => candidate.title === 'Происшествия')) {
      const record = call(session, 'GET', `/datasets/${item.id}`, undefined, 'setup').json()
      if (!best || record.rowCount > best.rowCount) best = record
    }
    datasetId = best?.id ?? null
  }
  if (!datasetId) {
    fail('нет датасета «Происшествия» — загрузите демо-датасеты: pnpm db:seed --data=demo')
  }
  const dataset = call(session, 'GET', `/datasets/${datasetId}`, undefined, 'setup').json()
  if (dataset.rowCount < MIN_ROWS) {
    fail(
      `в «Происшествиях» ${dataset.rowCount} строк — нужен профиль demo (pnpm db:seed --data=demo)`,
    )
  }
  const territories = call(session, 'GET', '/territories', undefined, 'setup').json('items')
  const districts = territories.filter((item) => item.level === 'district').map((item) => item.id)
  if (districts.length === 0) fail('справочник территорий пуст — выполните pnpm db:seed')
  return { session, datasetId, rows: dataset.rowCount, districts }
}

const pick = (items) => items[Math.floor(Math.random() * items.length)]

/** Случайный день периода демо-данных (2024-01-01 … 2026-08-31), ISO-дата. */
function randomDay(spanDays = 0) {
  const start = Date.UTC(2024, 0, 1)
  const days = Math.floor(Math.random() * (974 - spanDays))
  return new Date(start + days * 86_400_000).toISOString().slice(0, 10)
}

function addDays(day, count) {
  return new Date(Date.parse(day) + count * 86_400_000).toISOString().slice(0, 10)
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

export function query(data) {
  const op = weightedOp()
  if (op === 'agg_region') {
    const from = randomDay(90)
    run(
      data,
      [
        {
          type: 'filter',
          where: { field: 'occurred_at', op: 'between', value: [from, addDays(from, 90)] },
        },
        {
          type: 'compute',
          fields: [
            { name: 'region', expr: "territory_level(territory, 'region')" },
            { name: 'region_name', expr: 'territory_name(region)' },
          ],
        },
        {
          type: 'aggregate',
          groupBy: [{ field: 'region_name' }],
          measures: [
            { alias: 'n', agg: 'count' },
            { alias: 'damage', agg: 'sum', field: 'damage' },
          ],
        },
        { type: 'sort', by: [{ field: 'n', dir: 'desc' }] },
      ],
      op,
    )
  } else if (op === 'agg_month') {
    const year = pick([2024, 2025, 2026])
    run(
      data,
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
  } else if (op === 'rows_page') {
    const offset = Math.floor(Math.random() * 100) * 100
    call(
      data.session,
      'POST',
      `/datasets/${data.datasetId}/rows/query`,
      { sort: [{ field: 'occurred_at', dir: 'desc' }], limit: 100, offset, count: offset === 0 },
      op,
    )
  } else if (op === 'drill') {
    const from = randomDay(31)
    run(
      data,
      [
        {
          type: 'filter',
          where: {
            and: [
              {
                field: 'territory',
                op: 'within',
                value: { id: pick(data.districts), includeChildren: false },
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
    call(data.session, 'GET', `/datasets/${data.datasetId}/fields/${field}/profile`, undefined, op)
  }
}

/** Итог — таблица p95 по видам запросов и, если задан KCHS_PERF_OUT, полный JSON. */
export function handleSummary(data) {
  const rows = []
  for (const [name, metric] of Object.entries(data.metrics)) {
    const match = /^http_req_duration\{op:(.+)\}$/.exec(name)
    if (!match) continue
    const failed = Object.values(metric.thresholds ?? {}).some((t) => !t.ok)
    const v = metric.values
    rows.push(
      `${match[1].padEnd(16)} ${String(v.count).padStart(6)} ${v.med.toFixed(1).padStart(8)} ` +
        `${v['p(95)'].toFixed(1).padStart(8)} ${v.max.toFixed(1).padStart(8)}  ${failed ? 'ВНЕ БЮДЖЕТА' : 'в бюджете'}`,
    )
  }
  const failedRate = data.metrics.http_req_failed?.values.rate ?? 0
  const text = [
    '',
    `k6: ${API}, запросы к датасету, ${RATE} запрос/с, ${DURATION}`,
    `${'операция'.padEnd(16)} ${'запросов'.padStart(6)} ${'медиана'.padStart(8)} ${'p95, мс'.padStart(8)} ${'макс'.padStart(8)}`,
    ...rows.sort(),
    `ошибки HTTP: ${(failedRate * 100).toFixed(2)} %`,
    '',
  ].join('\n')
  const out = { stdout: text }
  if (__ENV.KCHS_PERF_OUT) out[__ENV.KCHS_PERF_OUT] = JSON.stringify(data, null, 2)
  return out
}
