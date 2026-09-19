import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Бюджет тайлов (04-verification.md §4): слой на 500 тыс. точек — p95 ≤ 300 мс без
 * кэша и ≤ 50 мс из кэша. Замер на стороне сервера (inject: маршрут, права,
 * компиляция, SQL, сжатие, Redis) — без сети и браузера; сквозной замер — профиль
 * k6 `infra/perf/k6/gis-tiles.js`. Долгий: запускается только с KCHS_PERF=1.
 */
registerLifecycle()

const { redis } = await import('../src/shared/redis/index.js')
const redisKeys = (pattern: string) => redis().keys(pattern)
const redisDel = (keys: string[]) => redis().del(...keys)

const POINTS = Number(process.env.KCHS_PERF_POINTS ?? 500_000)
const SAMPLES = 40
const ZOOMS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
/** Города — плотные скопления, как у реальных объектов; остальное — по стране. */
const CITIES: Array<[number, number]> = [
  [68.78, 38.56],
  [69.62, 40.28],
  [68.78, 37.83],
  [69.78, 37.91],
  [71.55, 37.49],
  [70.63, 39.84],
  [68.25, 38.51],
  [69.0, 40.5],
]

let fx: TestContext
let datasetId: string

function tileOf(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return [
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  ]
}

const percentile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

describe.skipIf(!process.env.KCHS_PERF)('тайлы: бюджет на 500 тыс. точек', () => {
  let anchors: Array<[number, number]> = []

  beforeAll(async () => {
    fx = await setupFixture()
    const created = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: 'Нагрузка: точки',
        spaceId: fx.spaceId,
        fields: [
          { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
          { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
          { key: 'amount', label: { ru: 'Величина' }, type: 'number', semantic: 'measure' },
          { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
          { key: 'location', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    datasetId = created.json().id
    const [storage] = await db().execute<{ table: string; columns: Record<string, string> }>(
      sql`SELECT d.physical_table AS table,
                 jsonb_object_agg(f.key, f.physical_column) AS columns
            FROM datasets d JOIN dataset_fields f ON f.dataset_id = d.id
           WHERE d.id = ${datasetId} GROUP BY d.physical_table`,
    )
    if (!storage) throw new Error('нет физической таблицы')
    const column = (key: string) => `"${storage.columns[key]}"`
    const cities = CITIES.map(([lon, lat]) => `(${lon}, ${lat})`).join(', ')
    // Фикстура нагрузки: строки пишутся в физическую таблицу пачкой SQL — путь
    // вставки через API здесь не проверяется, а 500 запросов по 1 000 строк долги
    await db().execute(
      sql.raw(`INSERT INTO ds."${storage.table}" (${column('kind')}, ${column('district')},
                      ${column('amount')}, ${column('day')}, ${column('location')})
               SELECT (ARRAY['school','hospital','bridge','dam','shelter','substation'])[1 + (g % 6)],
                      'D' || (g % 58),
                      (g % 1000)::numeric,
                      DATE '2024-01-01' + (g % 900),
                      CASE WHEN g % 5 < 3
                        THEN ST_SetSRID(ST_MakePoint(c.lon + (random() - 0.5) * 0.3,
                                                     c.lat + (random() - 0.5) * 0.2), 4326)
                        ELSE ST_SetSRID(ST_MakePoint(67.4 + random() * 7.6,
                                                     36.7 + random() * 4.3), 4326)
                      END
                 FROM generate_series(1, ${POINTS}) g
                 JOIN (SELECT row_number() OVER () - 1 AS i, lon, lat
                         FROM (VALUES ${cities}) v(lon, lat)) c
                   ON c.i = g % ${CITIES.length}`),
    )
    await db().execute(sql.raw(`ANALYZE ds."${storage.table}"`))
    const sample = await db().execute<{ lon: number; lat: number }>(
      sql.raw(`SELECT ST_X(${column('location')}) AS lon, ST_Y(${column('location')}) AS lat
                 FROM ds."${storage.table}" ORDER BY random() LIMIT ${SAMPLES}`),
    )
    anchors = sample.map((row) => [Number(row.lon), Number(row.lat)])
  }, 600_000)

  async function measure(
    layerId: string,
    as: TestContext['admin'],
    zooms: number[],
    cold: boolean,
  ): Promise<{ all: number[]; byZoom: Map<number, number[]> }> {
    const all: number[] = []
    const byZoom = new Map<number, number[]>()
    for (const z of zooms) {
      const times: number[] = []
      for (const [lon, lat] of anchors) {
        const [x, y] = tileOf(lon, lat, z)
        if (cold) {
          const keys = await redisKeys(`kchs:tile:${layerId}:*`)
          if (keys.length > 0) await redisDel(keys)
        }
        const started = performance.now()
        const response = await call(fx.app, {
          url: `/gis/layers/${layerId}/tiles/${z}/${x}/${y}.pbf`,
          as,
          headers: { 'accept-encoding': 'gzip' },
        })
        const ms = performance.now() - started
        expect([200, 204]).toContain(response.statusCode)
        expect(response.headers['x-kchs-tile']).toBeUndefined()
        times.push(ms)
        all.push(ms)
      }
      byZoom.set(z, times)
    }
    return { all, byZoom }
  }

  function report(title: string, result: { all: number[]; byZoom: Map<number, number[]> }) {
    const lines = [...result.byZoom].map(
      ([z, times]) =>
        `  z${z}: медиана ${percentile(times, 0.5).toFixed(0)} мс, p95 ${percentile(times, 0.95).toFixed(0)} мс`,
    )
    // biome-ignore lint/suspicious/noConsole: замеры времени нужны в журнале прогона
    console.info(
      `${title}: p95 ${percentile(result.all, 0.95).toFixed(0)} мс (${result.all.length} тайлов)\n${lines.join('\n')}`,
    )
  }

  it('точки с кластерами (стиль по умолчанию): холодные и из кэша', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: { name: 'Нагрузка', spaceId: fx.spaceId, datasetId, tileFields: ['kind'] },
    })
    expect(created.statusCode, created.body).toBe(200)
    const layerId = created.json().id
    const cold = await measure(layerId, fx.admin, ZOOMS, true)
    report(`${POINTS} точек, кластеры до z11, без кэша`, cold)
    const warm = await measure(layerId, fx.admin, ZOOMS, false)
    report(`${POINTS} точек, из кэша`, warm)
    expect(percentile(cold.all, 0.95)).toBeLessThanOrEqual(300)
    expect(percentile(warm.all, 0.95)).toBeLessThanOrEqual(50)
  }, 600_000)

  it('читатель с политикой строк: те же бюджеты', async () => {
    const policy = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/rows`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        filter: { field: 'district', op: 'in', value: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] },
      },
    })
    expect(policy.statusCode, policy.body).toBe(200)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: { name: 'Нагрузка: читатель', spaceId: fx.spaceId, datasetId },
    })
    const layerId = created.json().id
    const cold = await measure(layerId, fx.users.viewer, ZOOMS, true)
    report(`${POINTS} точек, политика строк, без кэша`, cold)
    expect(percentile(cold.all, 0.95)).toBeLessThanOrEqual(300)
  }, 600_000)

  it('точки без кластеров: крупные масштабы', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: {
        name: 'Нагрузка: без кластеров',
        spaceId: fx.spaceId,
        datasetId,
        style: {
          version: 1,
          geometry: 'point',
          renderer: {
            kind: 'categorized',
            field: 'kind',
            categories: [
              { value: 'school', color: 'categorical.1' },
              { value: 'hospital', color: 'categorical.2' },
            ],
          },
          minZoom: 10,
        },
      },
    })
    const layerId = created.json().id
    const cold = await measure(layerId, fx.admin, [10, 11, 12, 13, 14], true)
    report(`${POINTS} точек, без кластеров (z10+), без кэша`, cold)
    expect(percentile(cold.all, 0.95)).toBeLessThanOrEqual(300)
  }, 600_000)
})
