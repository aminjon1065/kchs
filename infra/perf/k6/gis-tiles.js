// Нагрузочный профиль векторных тайлов — бюджет 04-verification.md §4: «тайлы 500 тыс.
// точек — p95 ≤ 50 мс из кэша / ≤ 300 мс без». Источник — «Происшествия» демо-датасетов
// (5 млн строк, `pnpm db:seed --data=demo`, ADR-0063); слой профиля — точки с кластерами
// и временем по `occurred_at` (ADR-0064). Интервал времени — три месяца (≈ 500 тыс. точек
// из 5 млн), у каждого холодного запроса свой: ключ кэша тайла новый, замер — как у карты
// с ползунком времени. Кэшированные тайлы — один набор из 60 тайлов, прогретый в setup.
//
// Масштабы — как у просмотра карты: чаще 6–12, реже 5 и 13–14; точка тайла — случайная
// в экстенте слоя. Нагрузка по умолчанию — 4 холодных и 20 кэшированных тайлов в секунду.
//
// Запуск — KCHS_PERF_PROFILE=gis-tiles bash infra/perf/run-k6.sh; параметры — переменные
// KCHS_PERF_* (KCHS_PERF_DATASET — идентификатор датасета вместо поиска).
import { check, fail } from 'k6'
import http from 'k6/http'

const API = (__ENV.KCHS_PERF_API || 'http://host.docker.internal:3000/api/v1').replace(/\/$/, '')
const ADMIN = __ENV.KCHS_PERF_ADMIN || 'admin'
const ADMIN_PASSWORD = __ENV.KCHS_PERF_ADMIN_PASSWORD || 'Kchs!Start-2026-7q'
const COOKIE = __ENV.KCHS_PERF_COOKIE || 'kchs_session'
const RATE = Number(__ENV.KCHS_PERF_RATE || 4)
const CACHED_RATE = RATE * 5
const DURATION = __ENV.KCHS_PERF_DURATION || '2m'
const LAYER_NAME = 'Нагрузочный профиль: тайлы'
/** Меньше строк — не тот масштаб, бюджет на нём ничего не доказывает. */
const MIN_ROWS = 1_000_000
/** Период демо-данных «Происшествий» (ADR-0054): 2024-01-01 … 2026-08-31. */
const PERIOD_START = Date.UTC(2024, 0, 1)
const PERIOD_DAYS = 974
const WINDOW_DAYS = 91
const CACHED_TILES = 60
/** Доли масштабов: просмотр страны, области, района, города. */
const ZOOMS = [
  [5, 1],
  [6, 3],
  [7, 3],
  [8, 3],
  [9, 3],
  [10, 3],
  [11, 3],
  [12, 2],
  [13, 1],
  [14, 1],
]

export const options = {
  scenarios: {
    cold: {
      executor: 'constant-arrival-rate',
      exec: 'cold',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
    cached: {
      executor: 'constant-arrival-rate',
      exec: 'cached',
      rate: CACHED_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
  },
  thresholds: {
    'http_req_duration{op:tile_cold}': ['p(95)<300'],
    'http_req_duration{op:tile_cached}': ['p(95)<50'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'max', 'count'],
  setupTimeout: '120s',
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

function call(session, method, path, body) {
  const headers = { cookie: `${COOKIE}=${session.token}`, 'x-csrf-token': session.csrf }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = http.request(
    method,
    `${API}${path}`,
    body === undefined ? null : JSON.stringify(body),
    { headers, tags: { op: 'setup' }, timeout: '60s' },
  )
  if (res.status < 200 || res.status >= 300) fail(`${method} ${path}: ${res.status} ${res.body}`)
  return res
}

/** Стиль слоя профиля: точки с кластерами (как по умолчанию) и временем. */
const STYLE = {
  version: 1,
  geometry: 'point',
  renderer: { kind: 'simple', color: 'categorical.1' },
  cluster: { enabled: true },
  time: { field: 'occurred_at', mode: 'range', step: 'day' },
}

/** «Происшествия» (самый большой такой датасет), слой профиля и прогретый набор тайлов. */
export function setup() {
  const session = signIn()
  let datasetId = __ENV.KCHS_PERF_DATASET || null
  if (!datasetId) {
    const items = call(session, 'GET', '/objects?type=dataset&limit=200').json('items')
    let best = null
    for (const item of items.filter((candidate) => candidate.title === 'Происшествия')) {
      const record = call(session, 'GET', `/datasets/${item.id}`).json()
      if (!best || record.rowCount > best.rowCount) best = record
    }
    datasetId = best?.id ?? null
  }
  if (!datasetId) {
    fail('нет датасета «Происшествия» — загрузите демо-датасеты: pnpm db:seed --data=demo')
  }
  const dataset = call(session, 'GET', `/datasets/${datasetId}`).json()
  if (dataset.rowCount < MIN_ROWS) {
    fail(`в «Происшествиях» ${dataset.rowCount} строк — нужен профиль demo`)
  }
  const layers = call(session, 'GET', `/gis/layers?datasetId=${datasetId}`).json('items')
  let layerId = layers.find((layer) => layer.name === LAYER_NAME)?.id ?? null
  if (layerId) {
    call(session, 'PATCH', `/gis/layers/${layerId}`, { style: STYLE })
  } else {
    layerId = call(session, 'POST', '/gis/layers', {
      name: LAYER_NAME,
      spaceId: dataset.spaceId,
      datasetId,
      style: STYLE,
    }).json('id')
  }
  const layer = call(session, 'GET', `/gis/layers/${layerId}`).json()
  if (!layer.extent) fail('у слоя нет экстента — в датасете нет геометрий')

  // Кэшированный набор: фиксированный интервал, тайлы прогреваются здесь
  const window = randomWindow()
  const cachedTiles = []
  for (let i = 0; i < CACHED_TILES; i++) cachedTiles.push(randomTile(layer.extent))
  for (const tile of cachedTiles) {
    http.get(tileUrl(layerId, tile, window), tileParams(session, 'setup'))
  }
  return { session, layerId, extent: layer.extent, window, cachedTiles }
}

function randomWindow() {
  const from = PERIOD_START + Math.floor(Math.random() * (PERIOD_DAYS - WINDOW_DAYS)) * 86_400_000
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
  return `${iso(from)}/${iso(from + WINDOW_DAYS * 86_400_000)}`
}

function weightedZoom() {
  const total = ZOOMS.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = Math.random() * total
  for (const [zoom, weight] of ZOOMS) {
    roll -= weight
    if (roll < 0) return zoom
  }
  return ZOOMS[0][0]
}

/** Тайл случайного масштаба со случайной точкой экстента. */
function randomTile(extent) {
  const [west, south, east, north] = extent
  const z = weightedZoom()
  const lon = west + Math.random() * (east - west)
  const lat = south + Math.random() * (north - south)
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  }
}

function tileUrl(layerId, tile, window) {
  return `${API}/gis/layers/${layerId}/tiles/${tile.z}/${tile.x}/${tile.y}.pbf?t=${encodeURIComponent(window)}`
}

function tileParams(session, op, zoom) {
  return {
    headers: { cookie: `${COOKIE}=${session.token}`, 'accept-encoding': 'gzip' },
    tags: { op, ...(zoom === undefined ? {} : { zoom: String(zoom) }) },
    timeout: '30s',
  }
}

function checkTile(res, op) {
  check(res, {
    [`${op}: 200/204`]: (r) => r.status === 200 || r.status === 204,
    [`${op}: не тайм-аут`]: (r) => r.headers['X-Kchs-Tile'] !== 'timeout',
  })
}

export function cold(data) {
  const tile = randomTile(data.extent)
  const res = http.get(
    tileUrl(data.layerId, tile, randomWindow()),
    tileParams(data.session, 'tile_cold', tile.z),
  )
  checkTile(res, 'tile_cold')
}

export function cached(data) {
  const tile = data.cachedTiles[Math.floor(Math.random() * data.cachedTiles.length)]
  const res = http.get(
    tileUrl(data.layerId, tile, data.window),
    tileParams(data.session, 'tile_cached', tile.z),
  )
  checkTile(res, 'tile_cached')
}

/** Итог — p95 холодных и кэшированных тайлов и, если задан KCHS_PERF_OUT, полный JSON. */
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
    `k6: ${API}, тайлы слоя (≈ 500 тыс. точек в интервале), ${RATE} холодных и ${CACHED_RATE} кэшированных тайлов/с, ${DURATION}`,
    `${'операция'.padEnd(16)} ${'запросов'.padStart(6)} ${'медиана'.padStart(8)} ${'p95, мс'.padStart(8)} ${'макс'.padStart(8)}`,
    ...rows.sort(),
    `ошибки HTTP: ${(failedRate * 100).toFixed(2)} %`,
    '',
  ].join('\n')
  const out = { stdout: text }
  if (__ENV.KCHS_PERF_OUT) out[__ENV.KCHS_PERF_OUT] = JSON.stringify(data, null, 2)
  return out
}
