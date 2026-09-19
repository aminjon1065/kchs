import { gunzipSync } from 'node:zlib'
import { ChoroplethParams, choroplethLayerStyle } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'
import { decodeMvt } from './mvt.js'

/**
 * Хороплет-мастер (P2-E04 S04, ADR-0077; сценарий приёмки фазы 2 №4): «точки в
 * полигонах районов → хороплет объектов на 100 000 жителей». Параметры мастера →
 * объект `analysis` вида `choropleth` → задание материализует датасет «граница +
 * значение» с правами запустившего → слой с градуированным стилем → карта.
 */
registerLifecycle()

const { AnalysisService } = await import('../src/modules/data/domain/analysis-service.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

let fx: TestContext
let analyst: TestUser
let objectsId: string
const territory = new Map<string, string>()
const run = Date.now().toString(36)

const box = (w: number, s: number, e: number, n: number) =>
  `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`
const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })

/** Тайл XYZ, содержащий точку. */
function tileOf(lon: number, lat: number, z: number) {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  analyst = await createUser(fx.app, 'analyst_choropleth', ['employee'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'editor'),
  )
  await redis().del(`kchs:principals:${analyst.id}`)

  // Справочник и границы Душанбе: четыре района — четверти прямоугольника города
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
  await TerritoryService.invalidate()
  for (const item of await TerritoryService.list()) territory.set(item.code, item.id)
  const bounds: Array<[string, string]> = [
    ['TJ-DU', box(68.6, 38.4, 69.0, 38.7)],
    ['TJ-DU-01', box(68.8, 38.55, 69.0, 38.7)],
    ['TJ-DU-02', box(68.6, 38.55, 68.8, 38.7)],
    ['TJ-DU-03', box(68.6, 38.4, 68.8, 38.55)],
    ['TJ-DU-04', box(68.8, 38.4, 69.0, 38.55)],
  ]
  for (const [code, wkt] of bounds) {
    await db().execute(
      sql`UPDATE territories SET geom = ST_Multi(ST_GeomFromText(${wkt}, 4326)),
            area_km2 = ST_Area(ST_GeomFromText(${wkt}, 4326)::geography) / 1e6
          WHERE code = ${code}`,
    )
  }

  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Объекты защиты ${run}`,
      spaceId: fx.spaceId,
      territoryField: 'territory',
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        {
          key: 'capacity',
          label: { ru: 'Вместимость', en: 'Capacity' },
          type: 'integer',
          semantic: 'measure',
        },
        { key: 'territory', label: { ru: 'Территория' }, type: 'territory' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry', semantic: 'geometry' },
      ],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  objectsId = created.json().id
  const du = (code: string) => territory.get(code) as string
  const rows = [
    // Геометрия и поле территории согласны
    {
      code: 'O-1',
      kind: 'school',
      capacity: 100,
      territory: du('TJ-DU-02'),
      place: point(68.7, 38.6),
    },
    {
      code: 'O-2',
      kind: 'school',
      capacity: 200,
      territory: du('TJ-DU-02'),
      place: point(68.75, 38.65),
    },
    {
      code: 'O-3',
      kind: 'hospital',
      capacity: 50,
      territory: du('TJ-DU-01'),
      place: point(68.9, 38.6),
    },
    {
      code: 'O-4',
      kind: 'school',
      capacity: 300,
      territory: du('TJ-DU-04'),
      place: point(68.9, 38.5),
    },
    // Точка во Фирдавси, а поле говорит «Сино»
    {
      code: 'O-5',
      kind: 'school',
      capacity: 10,
      territory: du('TJ-DU-02'),
      place: point(68.7, 38.5),
    },
    // Вне Душанбе и без территории
    { code: 'O-6', kind: 'school', capacity: 5, territory: null, place: point(69.5, 37.5) },
    // Без геометрии
    { code: 'O-7', kind: 'hospital', capacity: 70, territory: du('TJ-DU-04'), place: null },
  ]
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${objectsId}/rows`,
    as: fx.admin,
    payload: { rows: rows.map((values) => ({ values })) },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)

  // Аналитику видны только школы
  const policy = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${objectsId}/policies/rows`,
    as: fx.admin,
    payload: {
      principal: { type: 'user', id: analyst.id },
      filter: { field: 'kind', op: 'eq', value: 'school' },
    },
  })
  expect(policy.statusCode, policy.body).toBe(200)
})

const params = (input: Record<string, unknown> = {}) => ({
  datasetId: objectsId,
  join: 'geometry',
  field: 'place',
  level: 'district',
  withinId: territory.get('TJ-DU'),
  measure: { agg: 'count' },
  ...input,
})

/** Строки результата — объектами по полям. */
function records(result: { fields: Array<{ name: string }>; rows: unknown[][] }) {
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
  )
}

async function preview(choropleth: Record<string, unknown>, as: TestUser = analyst) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/analyses/preview',
    as,
    payload: { choropleth },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as {
    fields: Array<{ name: string; type: string; label: { ru: string } | null }>
    rows: unknown[][]
  }
}

const byCode = (rows: Array<Record<string, unknown>>, key: string) =>
  Object.fromEntries(rows.map((row) => [row.code, row[key] === null ? null : Number(row[key])]))

/** Выполняет задание анализа, как воркер очереди `data`. */
async function runJob(jobId: string) {
  const [row] = await db().execute<{ payload: { analysisId: string } }>(
    sql`SELECT payload FROM jobs WHERE id = ${jobId}`,
  )
  await JobService.start(jobId)
  const result = await AnalysisService.execute(row?.payload as never, {
    recordId: jobId,
    progress: async () => undefined,
  })
  await JobService.finish(jobId, result)
  return result
}

describe('предпросмотр хороплета', () => {
  it('точки в районах: все районы уровня с границей, ноль без объектов, политики смотрящего', async () => {
    const admin = records(await preview(params(), fx.admin))
    expect(admin.map((row) => row.code)).toEqual(['TJ-DU-01', 'TJ-DU-02', 'TJ-DU-03', 'TJ-DU-04'])
    expect(byCode(admin, 'value')).toEqual({
      'TJ-DU-01': 1,
      'TJ-DU-02': 2,
      'TJ-DU-03': 1,
      'TJ-DU-04': 1,
    })
    // Аналитику видны только школы — больница Исмоили Сомони не считается
    const result = await preview(params())
    expect(byCode(records(result), 'value')).toEqual({
      'TJ-DU-01': 0,
      'TJ-DU-02': 2,
      'TJ-DU-03': 1,
      'TJ-DU-04': 1,
    })
    expect(result.fields.map((field) => [field.name, field.type])).toEqual([
      ['territory', 'territory'],
      ['code', 'identifier'],
      ['name', 'text'],
      ['value', 'integer'],
      ['geom', 'geometry'],
    ])
    expect(result.fields.find((field) => field.name === 'territory')?.label?.ru).toBe('Район')
    const sino = records(result).find((row) => row.code === 'TJ-DU-02')
    expect(sino).toMatchObject({ name: 'Сино', territory: territory.get('TJ-DU-02') })
    expect((sino?.geom as { type?: string } | undefined)?.type).toBe('MultiPolygon')
  })

  it('поле территории: значение поля, а не положение точки; строки без геометрии тоже', async () => {
    const rows = records(await preview(params({ join: 'territory', field: 'territory' }), fx.admin))
    expect(byCode(rows, 'value')).toEqual({
      'TJ-DU-01': 1,
      'TJ-DU-02': 3,
      'TJ-DU-03': 0,
      'TJ-DU-04': 2,
    })
  })

  it('сумма поля и нормализация на население — на 100 000 жителей', async () => {
    const result = await preview(
      params({
        measure: { agg: 'sum', field: 'capacity' },
        normalize: 'population',
        per: 100_000,
      }),
      fx.admin,
    )
    const rows = records(result)
    expect(byCode(rows, 'value')).toEqual({
      'TJ-DU-01': 50,
      'TJ-DU-02': 300,
      'TJ-DU-03': 10,
      'TJ-DU-04': 300,
    })
    expect(byCode(rows, 'population')).toEqual({
      'TJ-DU-01': 220_000,
      'TJ-DU-02': 400_000,
      'TJ-DU-03': 330_000,
      'TJ-DU-04': 290_000,
    })
    const rate = byCode(rows, 'rate')
    expect(rate['TJ-DU-02']).toBeCloseTo(75, 6)
    expect(rate['TJ-DU-04']).toBeCloseTo((300 / 290_000) * 100_000, 6)
    expect(result.fields.find((field) => field.name === 'rate')?.label?.ru).toMatch(
      /^Сумма: Вместимость на 100.000 жителей$/,
    )
  })

  it('нормализация на площадь: значение на км²', async () => {
    const rows = records(await preview(params({ normalize: 'area', per: 1 }), fx.admin))
    const area = byCode(rows, 'area_km2')
    const rate = byCode(rows, 'rate')
    expect(area['TJ-DU-02']).toBeGreaterThan(100)
    expect(rate['TJ-DU-02']).toBeCloseTo(2 / (area['TJ-DU-02'] as number), 9)
  })

  it('параметры проверяются: поле, мера, доступ к источнику', async () => {
    const wrongField = await call(fx.app, {
      method: 'POST',
      url: '/analyses/preview',
      as: analyst,
      payload: { choropleth: params({ field: 'territory' }) },
    })
    expect(wrongField.statusCode).toBe(400)
    expect(wrongField.json().detail).toBe('В датасете нет поля геометрии «territory»')

    const noField = await call(fx.app, {
      method: 'POST',
      url: '/analyses/preview',
      as: analyst,
      payload: { choropleth: params({ measure: { agg: 'sum' } }) },
    })
    expect(noField.statusCode).toBe(400)

    const both = await call(fx.app, {
      method: 'POST',
      url: '/analyses',
      as: analyst,
      payload: {
        name: 'Оба',
        spaceId: fx.spaceId,
        choropleth: params(),
        query: { version: 1, source: { kind: 'dataset', id: objectsId }, steps: [] },
      },
    })
    expect(both.statusCode).toBe(400)

    const stranger = await call(fx.app, {
      method: 'POST',
      url: '/analyses/preview',
      as: fx.users.stranger,
      payload: { choropleth: params() },
    })
    expect(stranger.statusCode).toBe(404)
  })
})

describe('хороплет: анализ → датасет → слой → карта', () => {
  let analysisId: string
  let outputId: string
  let layerId: string
  const choropleth = () => ChoroplethParams.parse(params({ normalize: 'population', per: 100_000 }))

  it('мастер создаёт анализ вида choropleth, задание — датасет с правами запустившего', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/analyses',
      as: analyst,
      payload: {
        name: `Объекты на 100 000 жителей ${run}`,
        spaceId: fx.spaceId,
        outputName: `Хороплет объектов ${run}`,
        choropleth: choropleth(),
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const record = created.json()
    analysisId = record.id
    expect(record).toMatchObject({
      kind: 'choropleth',
      status: 'queued',
      inputDatasetIds: [objectsId],
      choropleth: { join: 'geometry', level: 'district', normalize: 'population', per: 100_000 },
    })
    expect(record.query.source).toEqual({ kind: 'dataset', id: objectsId, alias: 'd' })

    const result = await runJob(record.jobId)
    expect(result).toMatchObject({ rows: 4, created: true })
    outputId = result.datasetId

    const dataset = (await call(fx.app, { url: `/datasets/${outputId}`, as: analyst })).json()
    expect(dataset.name).toBe(`Хороплет объектов ${run}`)
    expect(
      dataset.fields.map((field: { key: string; type: string; label: { ru: string } }) => [
        field.key,
        field.type,
        field.label.ru,
      ]),
    ).toEqual([
      ['territory', 'territory', 'Район'],
      ['code', 'identifier', 'Код'],
      ['name', 'text', 'Название'],
      ['value', 'integer', 'Количество'],
      ['population', 'integer', 'Население'],
      ['rate', 'number', expect.stringMatching(/^Количество на 100.000 жителей$/)],
      ['geom', 'geometry', 'Граница'],
    ])
    // Строки посчитаны с политикой аналитика: только школы
    const rows = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: analyst,
      payload: {
        spec: {
          version: 1,
          source: { kind: 'dataset', id: outputId },
          steps: [{ type: 'sort', by: [{ field: 'code', dir: 'asc' }] }],
        },
      },
    })
    expect(rows.statusCode, rows.body).toBe(200)
    const values = records(rows.json())
    expect(byCode(values, 'value')).toEqual({
      'TJ-DU-01': 0,
      'TJ-DU-02': 2,
      'TJ-DU-03': 1,
      'TJ-DU-04': 1,
    })
    expect(byCode(values, 'rate')['TJ-DU-02']).toBeCloseTo(0.5, 9)

    const card = (await call(fx.app, { url: `/analyses/${analysisId}`, as: analyst })).json()
    expect(card).toMatchObject({ status: 'succeeded', outputDatasetId: outputId, rowCount: 4 })
  })

  it('слой хороплета: градуированный стиль по нормализованному значению, тайлы, карта', async () => {
    const style = choroplethLayerStyle(choropleth())
    expect(style.renderer).toMatchObject({ kind: 'graduated', field: 'rate', method: 'quantile' })
    const layer = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: analyst,
      payload: {
        name: `Объекты на 100 000 жителей ${run}`,
        spaceId: fx.spaceId,
        datasetId: outputId,
        style,
      },
    })
    expect(layer.statusCode, layer.body).toBe(200)
    layerId = layer.json().id
    const record = (await call(fx.app, { url: `/gis/layers/${layerId}`, as: analyst })).json()
    expect(record).toMatchObject({ geometryType: 'polygon', dataAccess: true, featureCount: 4 })
    expect(record.style.popup).toEqual({
      title: '{{name}}',
      fields: ['rate', 'value', 'population'],
      actions: ['open'],
    })

    // Тайл Душанбе: четыре района со значением и названием
    const at = tileOf(68.8, 38.55, 9)
    const tile = await call(fx.app, {
      url: `/gis/layers/${layerId}/tiles/${at.z}/${at.x}/${at.y}.pbf`,
      as: analyst,
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(tile.statusCode, tile.body).toBe(200)
    const raw = (tile as unknown as { rawPayload: Buffer }).rawPayload
    const features = decodeMvt(gunzipSync(raw))[0]?.features ?? []
    expect(features.map((feature) => feature.properties.name).sort()).toEqual([
      'Исмоили Сомони',
      'Сино',
      'Фирдавси',
      'Шохмансур',
    ])
    expect(features.every((feature) => typeof feature.properties.rate === 'number')).toBe(true)

    const map = await call(fx.app, {
      method: 'POST',
      url: '/gis/maps',
      as: analyst,
      payload: {
        name: `Хороплет ${run}`,
        spaceId: fx.spaceId,
        spec: { layers: [{ layerId, visible: true, opacity: 1, group: null }] },
      },
    })
    expect(map.statusCode, map.body).toBe(200)
    const saved = (await call(fx.app, { url: `/gis/maps/${map.json().id}`, as: analyst })).json()
    expect(saved.spec.layers.map((entry: { layerId: string }) => entry.layerId)).toEqual([layerId])
    expect(saved.extent).not.toBeNull()
  })

  it('перезапуск хороплета заменяет строки того же датасета', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/analyses/${analysisId}/run`,
      as: analyst,
    })
    expect(started.statusCode, started.body).toBe(200)
    const result = await runJob(started.json().jobId)
    expect(result).toMatchObject({ datasetId: outputId, rows: 4, created: false })
  })
})
