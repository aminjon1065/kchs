import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Границы территорий и внутренний геокодер (P2-E04 S03, S06; ADR-0067): загрузка
 * границ из seed-файла, регион и страна — объединения, GeoJSON с упрощением, векторные
 * тайлы с кэшем, геокодер по названию и коду, обратное геокодирование.
 */
registerLifecycle()

const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const json = { with: { type: 'json' } } as const
const TERRITORIES = (await import('../src/seed/territories.json', json)).default
const SETTLEMENTS = (await import('../src/seed/settlements.json', json)).default
const BOUNDARIES = (await import('../src/seed/territory-boundaries.json', json)).default

let fx: TestContext
const ids = new Map<string, string>()

beforeAll(async () => {
  fx = await setupFixture()
  const updated = await db().transaction(async (tx) => {
    await TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never)
    await TerritoryService.load(tx, systemCtx('test'), SETTLEMENTS as never)
    return TerritoryService.loadBoundaries(tx, systemCtx('test'), BOUNDARIES)
  })
  // 68 районов из файла, 5 регионов и страна — объединения
  expect(updated).toBe(74)
  await TerritoryService.invalidate()
  for (const item of await TerritoryService.list()) ids.set(item.code, item.id)
})

/** Номер тайла, в который попадает точка (схема XYZ). */
function tileOf(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom
  const rad = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  }
}

interface MvtLayer {
  name: string
  features: number
  keys: string[]
  values: string[]
}

/** Разбор тайла MVT (protobuf): имена слоёв, число объектов, ключи и строковые значения. */
function readTile(buffer: Buffer): MvtLayer[] {
  const read = (bytes: Buffer, visit: (field: number, value: Buffer | number) => void) => {
    let at = 0
    const varint = () => {
      let result = 0
      let shift = 0
      for (;;) {
        const byte = bytes[at++] as number
        result += (byte & 0x7f) * 2 ** shift
        if (byte < 0x80) return result
        shift += 7
      }
    }
    while (at < bytes.length) {
      const tag = varint()
      const field = Math.floor(tag / 8)
      const wire = tag % 8
      if (wire === 0) visit(field, varint())
      else if (wire === 2) {
        const length = varint()
        visit(field, bytes.subarray(at, at + length))
        at += length
      } else if (wire === 5) at += 4
      else if (wire === 1) at += 8
      else throw new Error(`неизвестный тип поля ${wire}`)
    }
  }
  const layers: MvtLayer[] = []
  read(buffer, (field, value) => {
    if (field !== 3 || typeof value === 'number') return
    const layer: MvtLayer = { name: '', features: 0, keys: [], values: [] }
    read(value, (inner, content) => {
      if (typeof content === 'number') return
      if (inner === 1) layer.name = content.toString('utf8')
      else if (inner === 2) layer.features += 1
      else if (inner === 3) layer.keys.push(content.toString('utf8'))
      else if (inner === 4) {
        read(content, (kind, item) => {
          if (kind === 1 && typeof item !== 'number') layer.values.push(item.toString('utf8'))
        })
      }
    })
    layers.push(layer)
  })
  return layers
}

const raw = (response: unknown) => (response as { rawPayload: Buffer }).rawPayload

describe('границы территорий', () => {
  it('загрузка: валидные MultiPolygon, центроид внутри, регион и страна — объединения; повтор ничего не меняет', async () => {
    const rows = await db().execute<{
      code: string
      level: string
      valid: boolean
      type: string
      area: number
      inside: boolean
    }>(sql`SELECT code, level, ST_IsValid(geom) AS valid, GeometryType(geom) AS type,
             area_km2 AS area, ST_Covers(geom, centroid) AS inside
             FROM territories WHERE geom IS NOT NULL ORDER BY code`)
    expect(rows).toHaveLength(74)
    for (const row of rows) {
      expect(row, row.code).toMatchObject({ valid: true, type: 'MULTIPOLYGON', inside: true })
      expect(row.area, row.code).toBeGreaterThan(0)
    }
    const area = (code: string) => rows.find((row) => row.code === code)?.area ?? 0
    // Таджикистан ≈ 141–143 тыс. км²; регионы без наложений складываются в страну
    expect(area('TJ')).toBeGreaterThan(138_000)
    expect(area('TJ')).toBeLessThan(146_000)
    const regions = rows.filter((row) => row.level === 'region')
    expect(regions.reduce((sum, row) => sum + row.area, 0)).toBeCloseTo(area('TJ'), -1)

    // Хатлон — ровно объединение своих районов
    const [khatlon] = await db().execute<{ diff: number }>(sql`
      SELECT ST_Area(ST_SymDifference(r.geom,
               (SELECT ST_Union(d.geom) FROM territories d WHERE d.parent_id = r.id))::geography) AS diff
        FROM territories r WHERE r.code = 'TJ-KT'`)
    expect(khatlon?.diff).toBeLessThan(1)

    const [attributes] = await db().execute<{ boundary: Record<string, string> }>(
      sql`SELECT attributes -> 'boundary' AS boundary FROM territories WHERE code = 'TJ-KT-01'`,
    )
    expect(attributes?.boundary).toMatchObject({ method: 'circle', source: BOUNDARIES.source })

    const again = await db().transaction((tx) =>
      TerritoryService.loadBoundaries(tx, systemCtx('test'), BOUNDARIES),
    )
    expect(again).toBe(0)
    const events = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ops.outbox WHERE type = 'territory.updated'`,
    )
    expect(events[0]?.n).toBe(74)
  })

  it('граница района меняется — пересчитываются регион и страна, остальные не трогаются', async () => {
    const units = BOUNDARIES.units.map((unit) =>
      unit.code === 'TJ-GB-05'
        ? {
            ...unit,
            geometry: {
              type: 'MultiPolygon',
              coordinates: [
                [
                  [
                    [73.5, 38.0],
                    [74.5, 38.0],
                    [74.5, 38.6],
                    [73.5, 38.6],
                    [73.5, 38.0],
                  ],
                ],
              ],
            },
          }
        : unit,
    )
    const changed = await db().transaction((tx) =>
      TerritoryService.loadBoundaries(tx, systemCtx('test'), { ...BOUNDARIES, units }),
    )
    expect(changed).toBe(3)
    // Вернуть как было — снова три единицы
    const restored = await db().transaction((tx) =>
      TerritoryService.loadBoundaries(tx, systemCtx('test'), BOUNDARIES),
    )
    expect(restored).toBe(3)
    await TerritoryService.invalidate()
  })

  it('карточка: экстент, площадь и признак границы; у кишлака границы нет', async () => {
    const district = await call(fx.app, {
      url: `/territories/${ids.get('TJ-KT-07')}`,
      as: fx.users.stranger,
    })
    expect(district.statusCode, district.body).toBe(200)
    const body = district.json()
    expect(body.hasGeometry).toBe(true)
    expect(body.areaKm2).toBeGreaterThan(100)
    const [west, south, east, north] = body.bbox as number[]
    expect(west).toBeLessThan(east as number)
    expect(south).toBeLessThan(north as number)
    expect(body.centroid.lon).toBeGreaterThan(west as number)
    expect(body.centroid.lon).toBeLessThan(east as number)

    // Центр города внутри его границы — остаётся заданным
    const bokhtar = await call(fx.app, { url: `/territories/${ids.get('TJ-KT-01')}`, as: fx.admin })
    expect(bokhtar.json().centroid.lon).toBeCloseTo(68.781, 3)

    const village = await call(fx.app, {
      url: `/territories/${ids.get('TJ-KT-07-01')}`,
      as: fx.users.stranger,
    })
    expect(village.json()).toMatchObject({ level: 'settlement', hasGeometry: false, bbox: null })
    expect(village.json().path.map((item: { code: string }) => item.code)).toEqual([
      'TJ',
      'TJ-KT',
      'TJ-KT-07',
    ])
  })

  it('граница GeoJSON: полная и упрощённая по зуму; без границы — 404', async () => {
    const vertices = (geometry: { coordinates: number[][][][] }) =>
      geometry.coordinates.flat(2).length
    const full = await call(fx.app, {
      url: `/gis/territories/${ids.get('TJ-KT')}/geometry`,
      as: fx.users.stranger,
    })
    expect(full.statusCode, full.body).toBe(200)
    const feature = full.json()
    expect(feature).toMatchObject({
      type: 'Feature',
      id: ids.get('TJ-KT'),
      properties: { code: 'TJ-KT', level: 'region' },
      geometry: { type: 'MultiPolygon' },
    })
    expect(feature.bbox).toHaveLength(4)

    const coarse = await call(fx.app, {
      url: `/gis/territories/${ids.get('TJ-KT')}/geometry?zoom=5`,
      as: fx.users.stranger,
    })
    expect(coarse.statusCode, coarse.body).toBe(200)
    expect(vertices(coarse.json().geometry)).toBeLessThan(vertices(feature.geometry) / 4)

    const village = await call(fx.app, {
      url: `/gis/territories/${ids.get('TJ-KT-07-01')}/geometry`,
      as: fx.users.stranger,
    })
    expect(village.statusCode).toBe(404)
  })

  it('тайлы: слой на уровень, названия на языке, ETag и кэш; пустой тайл — 204', async () => {
    const { x, y } = tileOf(68.78, 38.56, 8)
    const url = `/gis/territories/tiles/8/${x}/${y}.pbf?level=region,district&lang=en`
    const tile = await call(fx.app, { url, as: fx.users.stranger })
    expect(tile.statusCode, tile.body).toBe(200)
    expect(tile.headers['content-type']).toBe('application/vnd.mapbox-vector-tile')
    const layers = readTile(raw(tile))
    expect(layers.map((layer) => layer.name)).toEqual(['region', 'district'])
    const districts = layers[1] as MvtLayer
    expect(districts.keys).toEqual(expect.arrayContaining(['id', 'code', 'level', 'name']))
    expect(districts.values).toEqual(expect.arrayContaining(['TJ-DU-02', 'Sino', 'district']))
    expect(layers[0]?.values).toEqual(expect.arrayContaining(['TJ-DU', 'Dushanbe']))

    const etag = tile.headers.etag as string
    const cached = await redis().keys('kchs:gis:territory-tile:*')
    expect(cached.length).toBeGreaterThan(0)
    const again = await call(fx.app, {
      url,
      as: fx.users.stranger,
      headers: { 'if-none-match': etag },
    })
    expect(again.statusCode).toBe(304)

    // Русские названия — другой тайл; без уровней на зуме 3 — страна и регионы
    const russian = await call(fx.app, {
      url: `/gis/territories/tiles/8/${x}/${y}.pbf?level=district`,
      as: fx.users.stranger,
    })
    expect(readTile(raw(russian))[0]?.values).toEqual(expect.arrayContaining(['Сино']))
    const low = tileOf(71, 38.8, 3)
    const overview = await call(fx.app, {
      url: `/gis/territories/tiles/3/${low.x}/${low.y}.pbf`,
      as: fx.users.stranger,
    })
    expect(readTile(raw(overview)).map((layer) => layer.name)).toEqual(['country', 'region'])

    // Кишлаки — точки уровня settlement
    const village = SETTLEMENTS.find((item) => item.code === 'TJ-KT-07-01') as {
      centroid: number[]
    }
    const [lon = 0, lat = 0] = village.centroid
    const near = tileOf(lon, lat, 11)
    const points = await call(fx.app, {
      url: `/gis/territories/tiles/11/${near.x}/${near.y}.pbf?level=settlement`,
      as: fx.users.stranger,
    })
    expect(points.statusCode, points.body).toBe(200)
    expect(readTile(raw(points))[0]?.values).toEqual(expect.arrayContaining(['TJ-KT-07-01']))

    const empty = await call(fx.app, { url: '/gis/territories/tiles/8/0/0.pbf', as: fx.admin })
    expect(empty.statusCode).toBe(204)
    const outside = await call(fx.app, { url: '/gis/territories/tiles/2/4/0.pbf', as: fx.admin })
    expect(outside.statusCode).toBe(400)
    const badLevel = await call(fx.app, {
      url: `/gis/territories/tiles/8/${x}/${y}.pbf?level=province`,
      as: fx.admin,
    })
    expect(badLevel.statusCode).toBe(400)
  })

  it('геокодер: название на любом языке, код, уточнение района', async () => {
    const geocode = async (q: string, limit = 10) => {
      const response = await call(fx.app, {
        url: `/gis/geocode?q=${encodeURIComponent(q)}&limit=${limit}`,
        as: fx.users.stranger,
      })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().items as Array<{
        territory: { code: string; level: string }
        path: Array<{ code: string }>
        center: { lon: number; lat: number }
        bbox: number[] | null
        match: string
      }>
    }

    const [khatlon] = await geocode('Хатлон')
    expect(khatlon).toMatchObject({ territory: { code: 'TJ-KT' }, match: 'prefix' })
    expect(khatlon?.bbox).toHaveLength(4)
    expect(khatlon?.path.map((item) => item.code)).toEqual(['TJ'])
    expect((await geocode('Khatlon'))[0]?.territory.code).toBe('TJ-KT')
    expect((await geocode('tj-kt-07'))[0]).toMatchObject({
      territory: { code: 'TJ-KT-07' },
      match: 'code',
    })
    // Таджикское «Кӯлоб» набрано без особых букв
    expect((await geocode('Кулоб'))[0]).toMatchObject({
      territory: { code: 'TJ-KT-02' },
      match: 'name',
    })

    // Кишлак: без границы — центр есть, экстента нет; уточнение районом через запятую
    const village = SETTLEMENTS.find((item) => item.code === 'TJ-KT-07-01') as {
      name: { ru: string }
    }
    const all = await geocode(village.name.ru, 50)
    expect(all.length).toBeGreaterThan(1)
    // Полное название раньше начала другого («Чинор» раньше «Чинорзор»)
    const inVakhsh = await geocode(`${village.name.ru}, Вахш`)
    expect(inVakhsh[0]).toMatchObject({
      territory: { code: 'TJ-KT-07-01' },
      bbox: null,
      match: 'name',
    })
    expect(inVakhsh[0]?.path.map((item) => item.code)).toEqual(['TJ', 'TJ-KT', 'TJ-KT-07'])
    for (const item of inVakhsh) expect(item.territory.code).toMatch(/^TJ-KT-07-/)
    expect(inVakhsh.length).toBeLessThan(all.length)

    expect(await geocode('Атлантида')).toEqual([])
  })

  it('обратное геокодирование: цепочка страна → регион → район и ближайший кишлак', async () => {
    // Кишлак, который лежит внутри своего района (часть синтетических — за его границей)
    const [inside] = await db().execute<{ code: string; lon: number; lat: number }>(sql`
      SELECT s.code, ST_X(s.centroid) AS lon, ST_Y(s.centroid) AS lat
        FROM territories s JOIN territories d ON d.id = s.parent_id
       WHERE s.level = 'settlement' AND ST_Covers(d.geom, s.centroid)
       ORDER BY s.code LIMIT 1`)
    expect(inside).toBeDefined()
    const point = inside as { code: string; lon: number; lat: number }
    const response = await call(fx.app, {
      url: `/gis/geocode/reverse?lon=${point.lon}&lat=${point.lat}`,
      as: fx.users.stranger,
    })
    expect(response.statusCode, response.body).toBe(200)
    const { chain, nearest } = response.json()
    const district = point.code.split('-').slice(0, 3).join('-')
    expect(chain.map((item: { code: string }) => item.code)).toEqual([
      'TJ',
      district.slice(0, 5),
      district,
    ])
    expect(nearest.territory.code).toBe(point.code)
    expect(nearest.distanceM).toBeLessThan(1)

    const nowhere = await call(fx.app, {
      url: '/gis/geocode/reverse?lon=10&lat=50',
      as: fx.users.stranger,
    })
    expect(nowhere.json()).toEqual({ chain: [], nearest: null })
    const invalid = await call(fx.app, { url: '/gis/geocode/reverse?lon=200&lat=0', as: fx.admin })
    expect(invalid.statusCode).toBe(400)
  })
})
