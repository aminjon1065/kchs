// Нагрузочный профиль тайлов масштаба S2. Порог перехода к S2 —
// «тайлы > 200 RPS» (15-admin-operations.md §8), поэтому профиль по умолчанию
// держит 200 запросов тайлов в секунду: пятая часть холодных (свой интервал
// времени у каждого — ключ кэша новый) и четыре пятых из кэша.
//
// Бюджеты — 04-verification.md §4: p95 ≤ 50 мс из кэша, ≤ 300 мс без кэша.
// Источник — «Происшествия» демо-датасетов (5 млн строк, ADR-0063); слой
// профиля — точки с кластерами и временем по occurred_at (ADR-0064).
//
// Запуск — KCHS_PERF_PROFILE=s2-tiles bash infra/perf/run-k6.sh
//   KCHS_PERF_TILE_RATE=200    всего тайлов в секунду
//   KCHS_PERF_COLD_SHARE=0.2   доля холодных
//   KCHS_PERF_DATASET=<id>     датасет вместо поиска по названию
import { check, fail } from 'k6'
import http from 'k6/http'
import {
  ADMIN,
  ADMIN_PASSWORD,
  API,
  budgets,
  COOKIE,
  INSECURE_TLS,
  must,
  num,
  PERIOD_DAYS,
  PERIOD_START,
  rampingStages,
  signIn,
  summary,
  text,
} from './lib/kchs.js'

const TILE_RATE = num('KCHS_PERF_TILE_RATE', 200)
const COLD_SHARE = num('KCHS_PERF_COLD_SHARE', 0.2)
const COLD_RATE = Math.max(1, Math.round(TILE_RATE * COLD_SHARE))
const CACHED_RATE = Math.max(1, TILE_RATE - COLD_RATE)
const DURATION = text('KCHS_PERF_DURATION', '5m')
const LAYER_NAME = 'Нагрузочный профиль S2: тайлы'
/** Меньше строк — не тот масштаб, бюджет на нём ничего не доказывает. */
const MIN_ROWS = 1_000_000
/** Интервал времени ≈ 500 тыс. точек из 5 млн — как ползунок времени на карте. */
const WINDOW_DAYS = 91
const CACHED_TILES = num('KCHS_PERF_CACHED_TILES', 120)

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

const STYLE = {
  version: 1,
  geometry: 'point',
  renderer: { kind: 'simple', color: 'categorical.1' },
  cluster: { enabled: true },
  time: { field: 'occurred_at', mode: 'range', step: 'day' },
}

export const options = {
  insecureSkipTLSVerify: INSECURE_TLS,
  scenarios: {
    cold: {
      executor: 'ramping-arrival-rate',
      exec: 'cold',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: COLD_RATE * 2,
      maxVUs: COLD_RATE * 8,
      stages: rampingStages(COLD_RATE, DURATION),
    },
    cached: {
      executor: 'ramping-arrival-rate',
      exec: 'cached',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: CACHED_RATE,
      maxVUs: CACHED_RATE * 4,
      stages: rampingStages(CACHED_RATE, DURATION),
    },
  },
  thresholds: {
    ...budgets({ tile_cold: 'p(95)<300', tile_cached: 'p(95)<50' }),
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'max', 'count'],
  setupTimeout: '300s',
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
  const t = encodeURIComponent(window)
  return `${API}/gis/layers/${layerId}/tiles/${tile.z}/${tile.x}/${tile.y}.pbf?t=${t}`
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

/** Слой профиля на «Происшествиях» и прогретый набор кэшированных тайлов. */
export function prepareTiles(session) {
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

  const layers = must(session, 'GET', `/gis/layers?datasetId=${datasetId}`).json('items')
  let layerId = layers.find((layer) => layer.name === LAYER_NAME)?.id ?? null
  if (layerId) {
    must(session, 'PATCH', `/gis/layers/${layerId}`, { style: STYLE })
  } else {
    layerId = must(session, 'POST', '/gis/layers', {
      name: LAYER_NAME,
      spaceId: dataset.spaceId,
      datasetId,
      style: STYLE,
    }).json('id')
  }
  const layer = must(session, 'GET', `/gis/layers/${layerId}`).json()
  if (!layer.extent) fail('у слоя нет экстента — в датасете нет геометрий')

  const window = randomWindow()
  const cachedTiles = []
  for (let i = 0; i < CACHED_TILES; i += 1) cachedTiles.push(randomTile(layer.extent))
  for (const tile of cachedTiles) {
    http.get(tileUrl(layerId, tile, window), tileParams(session, 'setup'))
  }
  return { session, layerId, extent: layer.extent, window, cachedTiles }
}

export function setup() {
  return prepareTiles(signIn(ADMIN, ADMIN_PASSWORD))
}

export function cold(data) {
  const tiles = data.tiles ?? data
  const tile = randomTile(tiles.extent)
  const res = http.get(
    tileUrl(tiles.layerId, tile, randomWindow()),
    tileParams(tiles.session, 'tile_cold', tile.z),
  )
  checkTile(res, 'tile_cold')
}

export function cached(data) {
  const tiles = data.tiles ?? data
  const tile = tiles.cachedTiles[Math.floor(Math.random() * tiles.cachedTiles.length)]
  const res = http.get(
    tileUrl(tiles.layerId, tile, tiles.window),
    tileParams(tiles.session, 'tile_cached', tile.z),
  )
  checkTile(res, 'tile_cached')
}

export function handleSummary(data) {
  return summary(
    `тайлы S2: ${COLD_RATE} холодных и ${CACHED_RATE} кэшированных в секунду, ${DURATION}`,
    data,
  )
}
