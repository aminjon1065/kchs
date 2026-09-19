import type { QuerySpec, QueryStep } from '@kchs/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CompileContext, compileQuery, type ResolvedDataset } from '../src/index.js'
import { databaseUrl, dataSql, ddlSql, dropSql, testTables } from './db.js'
import {
  archive,
  ctx,
  IDS,
  incidents,
  q,
  regions,
  src,
  staff,
  TERR_DU,
  TERR_DU_1,
  TERR_DU_2,
  TERR_KH,
} from './fixtures.js'
import {
  box,
  hospitals,
  roads,
  SPATIAL_IDS,
  territoriesDataset,
  zones,
  zonesSource,
} from './spatial-fixtures.js'

/**
 * Шаг spatial на настоящем PostGIS под ролью `kchs_query` (как execute.test.ts):
 * буфер, площадь и длина по geography, отношения к целям с их политиками,
 * ближайшие, присвоение территорий, соединение, сетки, растворение, вырезание.
 */
const url = databaseUrl()
const describeDb = url ? describe : describe.skip
const T = testTables('qspat')
const TABLES = {
  zones: 'ds.t_qspat_zones',
  hospitals: 'ds.t_qspat_hospitals',
  roads: 'ds.t_qspat_roads',
  territories: 'ds.t_qspat_territories',
}

const exec = {
  incidents: { ...incidents, table: T.incidents },
  zones: { ...zones, table: TABLES.zones },
  hospitals: { ...hospitals, table: TABLES.hospitals },
  roads: { ...roads, table: TABLES.roads },
}

function context(...overrides: ResolvedDataset[]): Partial<CompileContext> {
  const map = new Map<string, ResolvedDataset>(
    [
      exec.incidents,
      { ...regions, table: T.regions },
      { ...archive, table: T.archive },
      { ...staff, table: T.staff },
      exec.zones,
      exec.hospitals,
      exec.roads,
    ].map((item) => [item.id, item]),
  )
  for (const item of overrides) map.set(item.id, item)
  return {
    datasets: map,
    systemDatasets: new Map([['territories', territoriesDataset(TABLES.territories)]]),
  }
}

const SYSTEM = `_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  _ver integer NOT NULL DEFAULT 1,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  _deleted_at timestamptz,
  _import_id uuid`

const GEOMETRY = 'extensions.geometry(Geometry, 4326)'

function wkt(west: number, south: number, east: number, north: number): string {
  return `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`
}

const polygon = (w: number, s: number, e: number, n: number) =>
  `extensions.ST_GeomFromText('${wkt(w, s, e, n)}', 4326)`
const point = (lon: number, lat: number) =>
  `extensions.ST_SetSRID(extensions.ST_MakePoint(${lon}, ${lat}), 4326)`

const spatialDdl = `
DROP TABLE IF EXISTS ${Object.values(TABLES).join(', ')};
CREATE TABLE ${TABLES.zones} (${SYSTEM}, c_1 text, c_2 text, c_3 ${GEOMETRY});
CREATE TABLE ${TABLES.hospitals} (${SYSTEM}, c_1 text, c_2 bigint, c_3 ${GEOMETRY});
CREATE TABLE ${TABLES.roads} (${SYSTEM}, c_1 text, c_2 ${GEOMETRY});
CREATE TABLE ${TABLES.territories} (id uuid PRIMARY KEY, code text, level text, parent_id uuid,
  name text, geom extensions.geometry(MultiPolygon, 4326), area_km2 double precision);
INSERT INTO ${TABLES.zones} (c_1, c_2, c_3) VALUES
  ('Центр', 'urban', ${polygon(68.75, 38.5, 68.9, 38.62)}),
  ('Юг', 'rural', ${polygon(68.8, 37.4, 69.6, 38.0)}),
  ('Пусто', 'rural', ${polygon(70.0, 39.0, 70.5, 39.5)}),
  ('Граница', 'urban', ${polygon(68.9, 38.5, 69.1, 38.6)});
INSERT INTO ${TABLES.hospitals} (c_1, c_2, c_3) VALUES
  ('Больница 1', 100, ${point(68.78, 38.57)}),
  ('Больница 2', 50, ${point(69.0, 37.85)}),
  ('Больница 3', 10, ${point(70.0, 40.0)});
INSERT INTO ${TABLES.roads} (c_1, c_2) VALUES
  ('Трасса', extensions.ST_GeomFromText('LINESTRING(68.7 38.5, 68.8 38.5)', 4326)),
  ('Без геометрии', NULL);
INSERT INTO ${TABLES.territories} (id, code, level, parent_id, name, geom) VALUES
  ('${TERR_DU}', 'DU', 'region', NULL, 'Душанбе', extensions.ST_Multi(${polygon(68.6, 38.4, 69.0, 38.7)})),
  ('${TERR_DU_1}', 'DU-1', 'district', '${TERR_DU}', 'Сино', extensions.ST_Multi(${polygon(68.6, 38.4, 68.79, 38.7)})),
  ('${TERR_DU_2}', 'DU-2', 'district', '${TERR_DU}', 'Шохмансур', extensions.ST_Multi(${polygon(68.79, 38.4, 69.0, 38.7)})),
  ('${TERR_KH}', 'KH', 'region', NULL, 'Хатлон', extensions.ST_Multi(${polygon(68.5, 37.0, 70.0, 38.0)}));
`

type Row = Record<string, unknown>
type Geometry = { type: string; coordinates: unknown }

const spatial = (
  op: Extract<QueryStep, { type: 'spatial' }>['op'],
  params: Record<string, unknown> = {},
  target?: unknown,
): QueryStep => ({ type: 'spatial', op, params, ...(target !== undefined ? { target } : {}) })

const hospitalsTarget = { kind: 'dataset', id: SPATIAL_IDS.hospitals, alias: 'h' }
const incidentsTarget = { kind: 'dataset', id: IDS.incidents, alias: 'inc' }
const titles = (rows: Row[]) => rows.map((row) => row.title as string).sort()
const byName = (rows: Row[], key = 'name') =>
  Object.fromEntries(rows.map((row) => [row[key] as string, row]))
const typeOf = (row: Row | undefined) => (row?.geom as Geometry | null | undefined)?.type

describeDb('шаг spatial на PostGIS', () => {
  let db: postgres.Sql

  beforeAll(async () => {
    db = postgres(url as string, { max: 2, onnotice: () => {} })
    await db.unsafe(ddlSql(T))
    await db.unsafe(dataSql(T))
    await db.unsafe(spatialDdl)
  })

  afterAll(async () => {
    await db?.unsafe(dropSql(T))
    await db?.unsafe(`DROP TABLE IF EXISTS ${Object.values(TABLES).join(', ')}`)
    await db?.end()
  })

  /** Как в API: роль kchs_query, только чтение, путь поиска ds и extensions. */
  async function run(spec: QuerySpec, ...overrides: ResolvedDataset[]) {
    const compiled = compileQuery(spec, ctx(context(...overrides)))
    return db.begin('read only', async (tx) => {
      await tx.unsafe('SET LOCAL ROLE kchs_query')
      await tx.unsafe('SET LOCAL search_path = ds, extensions')
      await tx.unsafe(`SET LOCAL statement_timeout = ${compiled.timeoutMs}`)
      const rows = (await tx.unsafe(compiled.sql, compiled.params as never[])) as unknown as Row[]
      const counted = (await tx.unsafe(
        compiled.countSql,
        compiled.countParams as never[],
      )) as unknown as Row[]
      return { rows: [...rows], count: Number(counted[0]?.count), compiled }
    })
  }

  it('буфер по geography и площадь буфера ≈ π км²', async () => {
    const { rows } = await run(q(src(), [spatial('buffer', { distance: 1000 }), spatial('area')]))
    expect(rows).toHaveLength(10)
    const located = rows.filter((row) => row.geom !== null)
    expect(located).toHaveLength(7)
    for (const row of located) {
      expect((row.geom as Geometry).type).toBe('Polygon')
      expect(row.area_km2).toBeGreaterThan(3.05)
      expect(row.area_km2).toBeLessThan(3.15)
    }
    expect(rows.filter((row) => row.area_km2 === null)).toHaveLength(3)
  })

  it('буфер по полю с метрами', async () => {
    const { rows } = await run(
      q({ kind: 'dataset', id: SPATIAL_IDS.hospitals }, [
        spatial('buffer', { distanceField: 'beds' }),
        spatial('area', { as: 'zone_km2' }),
      ]),
    )
    const zone = byName(rows)
    // Радиус 100 м → π · 0,01 км²; 10 м → π · 0,0001 км²
    expect(zone['Больница 1']?.zone_km2).toBeCloseTo(0.0312, 3)
    expect(zone['Больница 3']?.zone_km2).toBeCloseTo(0.000312, 5)
  })

  it('центроид, площадь и длина (км², км)', async () => {
    const centroids = byName((await run(q(zonesSource(), [spatial('centroid')]))).rows)
    const center = centroids.Центр?.geom as Geometry
    expect(center.type).toBe('Point')
    const [lon, lat] = center.coordinates as [number, number]
    expect(lon).toBeCloseTo(68.825, 6)
    expect(lat).toBeCloseTo(38.56, 6)

    const areas = byName((await run(q(zonesSource(), [spatial('area')]))).rows)
    // 0,15° × 0,12° на широте 38,56°: ≈ 13,06 км × 13,32 км
    expect(areas.Центр?.area_km2).toBeGreaterThan(170)
    expect(areas.Центр?.area_km2).toBeLessThan(178)

    const lengths = byName(
      (await run(q({ kind: 'dataset', id: SPATIAL_IDS.roads }, [spatial('length')]))).rows,
    )
    // 0,1° долготы на широте 38,5°: ≈ 8,71 км
    expect(lengths.Трасса?.length_km).toBeGreaterThan(8.6)
    expect(lengths.Трасса?.length_km).toBeLessThan(8.8)
    expect(lengths['Без геометрии']?.length_km).toBeNull()
  })

  it('отношение к цели: геометрия, территории, датасет, отрицание', async () => {
    const within = async (step: QueryStep) => {
      const { rows, count } = await run(q(src(), [step]))
      expect(count).toBe(rows.length)
      return titles(rows)
    }
    expect(await within(spatial('intersects', {}, box(68.7, 38.5, 68.9, 38.6)))).toHaveLength(4)
    expect(await within(spatial('within', {}, { kind: 'territory', id: TERR_DU_1 }))).toEqual([
      'Пожар 50%_off',
      'Пожар на складе',
    ])
    expect(await within(spatial('within', {}, { kind: 'territory', level: 'district' }))).toEqual([
      'Пожар 50%_off',
      'Пожар в доме',
      'Пожар на складе',
      'Пожар, учения',
    ])
    expect(
      await within(spatial('intersects', {}, { kind: 'territory', ids: [TERR_DU_2, TERR_KH] })),
    ).toEqual(['Оползень', 'Паводок', 'Пожар в доме', 'Пожар в лесу', 'Пожар, учения'])
    expect(
      await within(spatial('intersects', { negate: true }, { kind: 'territory', id: TERR_DU_1 })),
    ).toEqual(['Оползень', 'Паводок', 'Пожар в доме', 'Пожар в лесу', 'Пожар, учения'])
    expect(
      await within(spatial('intersects', {}, { kind: 'dataset', id: SPATIAL_IDS.zones })),
    ).toHaveLength(6)
  })

  it('в радиусе объектов цели и с условием на цель', async () => {
    const near = async (distance: number, filter?: unknown) =>
      titles(
        (
          await run(
            q(src(), [
              spatial(
                'dwithin',
                { distance },
                { ...hospitalsTarget, ...(filter ? { filter } : {}) },
              ),
            ]),
          )
        ).rows,
      )
    expect(await near(2000)).toEqual(['Пожар на складе'])
    expect(await near(6000)).toEqual(['Пожар в доме', 'Пожар в лесу', 'Пожар на складе'])
    expect(await near(6000, { field: 'beds', op: 'gte', value: 60 })).toEqual([
      'Пожар в доме',
      'Пожар на складе',
    ])
  })

  it('ближайшие: поля цели, расстояние, несколько и предел', async () => {
    const one = byName(
      (await run(q(src(), [spatial('nearest', {}, hospitalsTarget)]))).rows,
      'title',
    )
    expect(Object.keys(one)).toHaveLength(10)
    expect(one['Пожар на складе']?.name).toBe('Больница 1')
    expect(Number(one['Пожар на складе']?.beds)).toBe(100)
    expect(one['Пожар на складе']?.distance_m).toBeGreaterThan(1100)
    expect(one['Пожар на складе']?.distance_m).toBeLessThan(1120)
    expect(one.Оползень?.name).toBe('Больница 2')
    expect(one.ДТП).toMatchObject({ name: null, distance_m: null })

    const two = (
      await run(q(src(), [spatial('nearest', { limit: 2, fields: ['name'] }, hospitalsTarget)]))
    ).rows
    expect(two).toHaveLength(7 * 2 + 3)
    const store = two
      .filter((row) => row.title === 'Пожар на складе')
      .sort((a, b) => Number(a.nearest_rank) - Number(b.nearest_rank))
    expect(store.map((row) => [row.name, Number(row.nearest_rank)])).toEqual([
      ['Больница 1', 1],
      ['Больница 2', 2],
    ])
    expect(store[0]).not.toHaveProperty('beds')

    const bounded = byName(
      (await run(q(src(), [spatial('nearest', { maxDistance: 3000 }, hospitalsTarget)]))).rows,
      'title',
    )
    expect(bounded['Пожар на складе']?.name).toBe('Больница 1')
    expect(bounded.Оползень?.name).toBeNull()

    const toPoint = byName(
      (
        await run(
          q(src(), [
            spatial(
              'nearest',
              {},
              { kind: 'geometry', geometry: { type: 'Point', coordinates: [68.78, 38.56] } },
            ),
          ]),
        )
      ).rows,
      'title',
    )
    expect(toPoint['Пожар на складе']?.distance_m).toBe(0)
    expect(toPoint['Пожар в доме']?.distance_m).toBeGreaterThan(1000)
  })

  it('присвоение территории уровня', async () => {
    const districts = byName(
      (await run(q(src(), [spatial('assign_territory', { level: 'district' })]))).rows,
      'title',
    )
    expect(districts['Пожар на складе']?.district_id).toBe(TERR_DU_1)
    expect(districts['Пожар 50%_off']?.district_id).toBe(TERR_DU_1)
    expect(districts['Пожар в доме']?.district_id).toBe(TERR_DU_2)
    expect(districts.Оползень?.district_id).toBeNull()
    expect(districts.ДТП?.district_id).toBeNull()

    const regionsOf = byName(
      (await run(q(src(), [spatial('assign_territory', { level: 'region', as: 'reg' })]))).rows,
      'title',
    )
    expect(regionsOf['Пожар, учения']?.reg).toBe(TERR_DU)
    expect(regionsOf['Пожар в лесу']?.reg).toBe(TERR_KH)
  })

  it('пространственное соединение: число и сумма, политики цели', async () => {
    const spec = q(zonesSource(), [
      spatial(
        'spatial_join',
        {
          measures: [
            { alias: 'incidents', agg: 'count' },
            { alias: 'damage', agg: 'sum', field: 'damage' },
          ],
        },
        incidentsTarget,
      ),
    ])
    const result = byName((await run(spec)).rows)
    expect(Number(result.Центр?.incidents)).toBe(3)
    expect(Number(result.Центр?.damage)).toBe(170000.5)
    expect(Number(result.Юг?.incidents)).toBe(3)
    expect(Number(result.Юг?.damage)).toBe(1100000)
    expect(Number(result.Пусто?.incidents)).toBe(0)
    expect(result.Пусто?.damage).toBeNull()

    // Политика строк цели: пожары смотрящему не видны — и в мерах их нет
    const noFires: ResolvedDataset = {
      ...exec.incidents,
      rowPolicy: { kind: 'filter', where: { field: 'kind', op: 'neq', value: 'fire' } },
    }
    const limited = byName((await run(spec, noFires)).rows)
    expect(Number(limited.Центр?.incidents)).toBe(0)
    expect(Number(limited.Юг?.incidents)).toBe(2)

    const radius = byName(
      (
        await run(
          q({ kind: 'dataset', id: SPATIAL_IDS.hospitals }, [
            spatial('spatial_join', { predicate: 'dwithin', distance: 3000 }, incidentsTarget),
          ]),
        )
      ).rows,
    )
    expect(Number(radius['Больница 1']?.count)).toBe(2)
    expect(Number(radius['Больница 2']?.count)).toBe(0)
  })

  it('справочник территорий как источник: объекты по районам', async () => {
    const { rows } = await run(
      q({ kind: 'system', name: 'territories' }, [
        { type: 'filter', where: { field: 'level', op: 'eq', value: 'district' } },
        spatial('spatial_join', {}, incidentsTarget),
        { type: 'sort', by: [{ field: 'code', dir: 'asc' }] },
      ]),
    )
    expect(rows.map((row) => [row.code, Number(row.count)])).toEqual([
      ['DU-1', 2],
      ['DU-2', 2],
    ])
  })

  it('сетки: квадраты и шестиугольники в метрах, меры по ячейкам', async () => {
    const square = await run(
      q(src(), [
        spatial('grid', {
          size: 1_000_000,
          measures: [
            { alias: 'count', agg: 'count' },
            { alias: 'damage', agg: 'sum', field: 'damage' },
          ],
        }),
      ]),
    )
    expect(square.rows).toHaveLength(1)
    expect(Number(square.rows[0]?.count)).toBe(7)
    expect(Number(square.rows[0]?.damage)).toBe(1271000.5)
    expect(typeOf(square.rows[0])).toBe('Polygon')

    const hex = await run(q(src(), [spatial('hexgrid', { size: 50_000 })]))
    expect(hex.rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(7)
    expect(new Set(hex.rows.map((row) => row.cell)).size).toBe(hex.rows.length)
    expect(hex.count).toBe(hex.rows.length)
    for (const row of hex.rows) {
      const ring = (row.geom as { coordinates: number[][][] }).coordinates[0] as number[][]
      // Шестиугольник: 6 вершин и замыкающая
      expect(ring).toHaveLength(7)
    }
  })

  it('растворение по полю и целиком', async () => {
    const kinds = byName(
      (await run(q(zonesSource(), [spatial('dissolve', { by: ['kind'] })]))).rows,
      'kind',
    )
    const urban = kinds.urban?.geom as { type: string; coordinates: unknown[] }
    const rural = kinds.rural?.geom as { type: string; coordinates: unknown[] }
    expect(urban.type).toBe('MultiPolygon')
    // Центр и Граница соприкасаются — один полигон; Юг и Пусто — два
    expect(urban.coordinates).toHaveLength(1)
    expect(rural.coordinates).toHaveLength(2)
    expect(Number(kinds.urban?.count)).toBe(2)

    const all = await run(q(src(), [spatial('dissolve')]))
    expect(all.rows).toHaveLength(1)
    expect(Number(all.rows[0]?.count)).toBe(7)
    expect(typeOf(all.rows[0])).toBe('MultiPoint')
  })

  it('вырезание по территории: полигоны и линии', async () => {
    const original = byName((await run(q(zonesSource(), [spatial('area')]))).rows)
    const clipped = await run(
      q(zonesSource(), [spatial('clip', {}, { kind: 'territory', id: TERR_DU }), spatial('area')]),
    )
    const parts = byName(clipped.rows)
    expect(Object.keys(parts).sort()).toEqual(['Граница', 'Центр'])
    expect(parts.Центр?.area_km2).toBeCloseTo(original.Центр?.area_km2 as number, 6)
    const share = (parts.Граница?.area_km2 as number) / (original.Граница?.area_km2 as number)
    expect(share).toBeGreaterThan(0.49)
    expect(share).toBeLessThan(0.51)

    const road = byName(
      (
        await run(
          q({ kind: 'dataset', id: SPATIAL_IDS.roads }, [
            spatial('clip', {}, { kind: 'territory', id: TERR_DU_1 }),
            spatial('length'),
          ]),
        )
      ).rows,
    )
    expect(typeOf(road.Трасса)).toBe('LineString')
    expect(road.Трасса?.length_km).toBeGreaterThan(7.7)
    expect(road.Трасса?.length_km).toBeLessThan(7.95)
  })
})
