import type { EventEnvelope } from '@kchs/contracts'
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

/**
 * Пространственный анализ (P2-E04 S01–S02, ADR-0069): шаг `spatial` в запросах,
 * справочник территорий как системный датасет, объект `analysis` — проверка
 * при создании, задание с правами запустившего на момент выполнения,
 * материализация в датасет, перезапуск с заменой строк, происхождение.
 * Задание выполняется напрямую, как это сделал бы воркер очереди `data`.
 */
registerLifecycle()

const { AnalysisService } = await import('../src/modules/data/domain/analysis-service.js')
const { registerAnalysisBackground } = await import('../src/modules/data/analysis-module.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { TerritoryService } = await import('../src/modules/gis/public.js')
const bus = await import('../src/kernel/events/index.js')
const { systemCtx } = await import('../src/shared/context.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

let fx: TestContext
let analyst: TestUser
let incidentsId: string
let zonesId: string
let policyId: string
const territory = new Map<string, string>()
const run = Date.now().toString(36)

const box = (w: number, s: number, e: number, n: number) =>
  `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`
const polygon = (w: number, s: number, e: number, n: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
})

async function createDataset(name: string, fields: unknown[], rows: Record<string, unknown>[]) {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId, fields },
  })
  expect(created.statusCode, created.body).toBe(200)
  const id = created.json().id as string
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${id}/rows`,
    as: fx.admin,
    payload: { rows: rows.map((values) => ({ values })) },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  return id
}

beforeAll(async () => {
  fx = await setupFixture()
  // Аналитик — редактор пространства: создаёт анализы и датасеты-результаты
  analyst = await createUser(fx.app, 'analyst_gis', ['employee'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'editor'),
  )
  await redis().del(`kchs:principals:${analyst.id}`)

  // Справочник территорий и границы трёх единиц Душанбе (прямоугольники для теста)
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
  await TerritoryService.invalidate()
  for (const item of await TerritoryService.list()) territory.set(item.code, item.id)
  const bounds: Array<[string, string]> = [
    ['TJ-DU', box(68.6, 38.4, 69.0, 38.7)],
    ['TJ-DU-02', box(68.6, 38.4, 68.79, 38.7)],
    ['TJ-DU-04', box(68.79, 38.4, 69.0, 38.7)],
  ]
  for (const [code, wkt] of bounds) {
    await db().execute(
      sql`UPDATE territories SET geom = ST_Multi(ST_GeomFromText(${wkt}, 4326)) WHERE code = ${code}`,
    )
  }

  const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })
  incidentsId = await createDataset(
    `Происшествия ${run}`,
    [
      { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
      { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
      { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
      { key: 'place', label: { ru: 'Место' }, type: 'geometry', semantic: 'geometry' },
    ],
    [
      { code: 'I-1', kind: 'fire', amount: 100, place: point(68.78, 38.56) },
      { code: 'I-2', kind: 'fire', amount: 200, place: point(68.8, 38.55) },
      { code: 'I-3', kind: 'flood', amount: 300, place: point(68.7, 38.6) },
      { code: 'I-4', kind: 'flood', amount: 400, place: point(69.5, 37.5) },
      { code: 'I-5', kind: 'fire', amount: 500, place: null },
    ],
  )
  zonesId = await createDataset(
    `Зоны ${run}`,
    [
      { key: 'name', label: { ru: 'Зона' }, type: 'text' },
      { key: 'area', label: { ru: 'Граница' }, type: 'geometry', semantic: 'geometry' },
    ],
    [
      { name: 'Центр', area: polygon(68.75, 38.5, 68.9, 38.62) },
      { name: 'Юг', area: polygon(68.8, 37.4, 69.6, 38.0) },
    ],
  )

  // Аналитику видны только пожары
  const policy = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${incidentsId}/policies/rows`,
    as: fx.admin,
    payload: {
      principal: { type: 'user', id: analyst.id },
      filter: { field: 'kind', op: 'eq', value: 'fire' },
    },
  })
  expect(policy.statusCode, policy.body).toBe(200)
  policyId = policy.json().id
})

const query = (steps: unknown[], source: unknown = { kind: 'dataset', id: incidentsId }) => ({
  version: 1,
  source,
  steps,
})

async function runQuery(spec: unknown, as: TestUser = fx.admin) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/queries/run',
    as,
    payload: { spec },
  })
  expect(response.statusCode, response.body).toBe(200)
  const result = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
  )
}

async function createAnalysis(payload: Record<string, unknown>, as: TestUser = analyst) {
  return call(fx.app, {
    method: 'POST',
    url: '/analyses',
    as,
    payload: { spaceId: fx.spaceId, ...payload },
  })
}

/** Выполняет задание, как воркер: успех — в реестр, сбой — `job.failed` и подписчик. */
async function runJob(jobId: string) {
  const [row] = await db().execute<{ payload: { analysisId: string } }>(
    sql`SELECT payload FROM jobs WHERE id = ${jobId}`,
  )
  await JobService.start(jobId)
  try {
    const result = await AnalysisService.execute(row?.payload as never, {
      recordId: jobId,
      progress: async () => undefined,
    })
    await JobService.finish(jobId, result)
    return result
  } catch (error) {
    await JobService.fail(jobId, error, { final: true })
    const subscriber = bus.listSubscribers().find((item) => item.name === 'data-analysis-failed')
    await subscriber?.handle({
      payload: { jobId, error: error instanceof Error ? error.message : String(error) },
    } as unknown as EventEnvelope)
    throw error
  }
}

describe('шаг spatial в запросах и справочник территорий', () => {
  it('территории — системный датасет: уровень, код, граница', async () => {
    const rows = await runQuery(
      query(
        [
          { type: 'filter', where: { field: 'code', op: 'starts_with', value: 'TJ-DU-0' } },
          { type: 'spatial', op: 'area', params: {} },
          { type: 'sort', by: [{ field: 'code', dir: 'asc' }] },
        ],
        { kind: 'system', name: 'territories' },
      ),
    )
    const sino = rows.find((row) => row.code === 'TJ-DU-02')
    expect(sino).toMatchObject({ level: 'district', name: 'Сино' })
    expect((sino?.geom as { type?: string } | undefined)?.type).toBe('MultiPolygon')
    // Поле area_km2 у справочника уже есть — вычисленная площадь получает номер
    expect(Number(sino?.area_km2_2)).toBeGreaterThan(100)
    expect(rows.find((row) => row.code === 'TJ-DU-01')?.geom).toBeNull()
  })

  it('присвоение района и отбор по территории — с политиками смотрящего', async () => {
    const assigned = await runQuery(
      query([
        { type: 'spatial', op: 'assign_territory', params: { level: 'district' } },
        { type: 'sort', by: [{ field: 'code', dir: 'asc' }] },
      ]),
    )
    expect(assigned.map((row) => [row.code, row.district_id])).toEqual([
      ['I-1', territory.get('TJ-DU-02')],
      ['I-2', territory.get('TJ-DU-04')],
      ['I-3', territory.get('TJ-DU-02')],
      ['I-4', null],
      ['I-5', null],
    ])
    const within = await runQuery(
      query([
        {
          type: 'spatial',
          op: 'within',
          params: {},
          target: { kind: 'territory', id: territory.get('TJ-DU-02') },
        },
      ]),
      analyst,
    )
    // Аналитику видны только пожары: из двух происшествий Сино — одно
    expect(within.map((row) => row.code)).toEqual(['I-1'])
  })
})

describe('объект «анализ»', () => {
  let analysisId: string
  let outputId: string

  it('создание проверяет запрос компилятором', async () => {
    const noSpatial = await createAnalysis({ name: 'Без операции', query: query([]) })
    expect(noSpatial.statusCode).toBe(400)
    expect(noSpatial.json().detail).toContain('шаг spatial')

    const invalid = await createAnalysis({
      name: 'Буфер без расстояния',
      query: query([{ type: 'spatial', op: 'buffer', params: {} }]),
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().data.issues[0]).toMatchObject({
      path: ['steps', 0, 'params'],
      message: 'Для буфера нужно расстояние: distance (метры) или distanceField',
    })

    // Чужой не видит датасет-источник — и анализ над ним не создаст
    const stranger = await createAnalysis(
      { name: 'Чужой', query: query([{ type: 'spatial', op: 'centroid', params: {} }]) },
      fx.users.stranger,
    )
    expect([403, 404]).toContain(stranger.statusCode)
  })

  it('запуск материализует результат с правами запустившего', async () => {
    const created = await createAnalysis({
      name: `Районы происшествий ${run}`,
      outputName: `Происшествия с районами ${run}`,
      query: query([{ type: 'spatial', op: 'assign_territory', params: { level: 'district' } }]),
    })
    expect(created.statusCode, created.body).toBe(200)
    const record = created.json()
    analysisId = record.id
    expect(record).toMatchObject({
      kind: 'assign_territory',
      status: 'queued',
      inputDatasetIds: [incidentsId],
      outputDatasetId: null,
    })

    const again = await call(fx.app, {
      method: 'POST',
      url: `/analyses/${analysisId}/run`,
      as: analyst,
    })
    expect(again.statusCode).toBe(409)

    const result = await runJob(record.jobId)
    // Политика аналитика: только пожары (I-1, I-2, I-5)
    expect(result).toMatchObject({ rows: 3, created: true })
    outputId = result.datasetId

    const card = (await call(fx.app, { url: `/analyses/${analysisId}`, as: analyst })).json()
    expect(card).toMatchObject({ status: 'succeeded', outputDatasetId: outputId, rowCount: 3 })

    const dataset = (await call(fx.app, { url: `/datasets/${outputId}`, as: analyst })).json()
    expect(dataset.name).toBe(`Происшествия с районами ${run}`)
    expect(dataset.settings).toEqual({ editable: false, trackHistory: false })
    expect(
      dataset.fields.map((field: { key: string; type: string }) => [field.key, field.type]),
    ).toEqual([
      ['code', 'identifier'],
      ['kind', 'text'],
      ['amount', 'number'],
      ['place', 'geometry'],
      ['district_id', 'territory'],
    ])

    const rows = await runQuery(
      query([{ type: 'sort', by: [{ field: 'code', dir: 'asc' }] }], {
        kind: 'dataset',
        id: outputId,
      }),
      analyst,
    )
    expect(rows.map((row) => [row.code, row.district_id])).toEqual([
      ['I-1', territory.get('TJ-DU-02')],
      ['I-2', territory.get('TJ-DU-04')],
      ['I-5', null],
    ])
    expect(rows[0]?.place).toEqual({ type: 'Point', coordinates: [68.78, 38.56] })

    // Происхождение: датасет выведен из анализа и источника, связь «Источник»
    const links = (await call(fx.app, { url: `/objects/${outputId}/links`, as: analyst })).json()
    expect(links.uses.map((item: { id: string }) => item.id).sort()).toEqual(
      [analysisId, incidentsId].sort(),
    )
    expect(links.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'source' })]),
    )

    const events = await db().execute<{ type: string }>(
      sql`SELECT type FROM ops.outbox WHERE event->'object'->>'id' IN (${analysisId}, ${outputId})
            ORDER BY id`,
    )
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'analysis.created',
        'analysis.queued',
        'analysis.started',
        'dataset.version_created',
        'analysis.finished',
      ]),
    )
  })

  it('перезапуск заменяет строки прежнего датасета новой версией', async () => {
    // Политика расширена: аналитику видны и паводки — это учтётся при выполнении
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${incidentsId}/policies/rows/${policyId}`,
      as: fx.admin,
      payload: { filter: { field: 'kind', op: 'in', value: ['fire', 'flood'] } },
    })
    expect(patched.statusCode, patched.body).toBe(200)

    const started = await call(fx.app, {
      method: 'POST',
      url: `/analyses/${analysisId}/run`,
      as: analyst,
    })
    expect(started.statusCode, started.body).toBe(200)
    const result = await runJob(started.json().jobId)
    expect(result).toMatchObject({ datasetId: outputId, rows: 5, created: false })

    const versions = (
      await call(fx.app, { url: `/datasets/${outputId}/versions`, as: analyst })
    ).json().items
    expect(versions.map((version: { origin: string }) => version.origin)).toEqual([
      'analysis',
      'analysis',
      'create',
    ])
    expect(versions[0].diff).toEqual({ added: 5, updated: 0, deleted: 3 })
  })

  it('пространственное соединение: меры по объектам цели с её политиками', async () => {
    const restored = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${incidentsId}/policies/rows/${policyId}`,
      as: fx.admin,
      payload: { filter: { field: 'kind', op: 'eq', value: 'fire' } },
    })
    expect(restored.statusCode, restored.body).toBe(200)
    const created = await createAnalysis({
      name: `Пожары по зонам ${run}`,
      query: query(
        [
          {
            type: 'spatial',
            op: 'spatial_join',
            params: {
              measures: [
                { alias: 'incidents', agg: 'count' },
                { alias: 'damage', agg: 'sum', field: 'amount' },
              ],
            },
            target: { kind: 'dataset', id: incidentsId, alias: 'inc' },
          },
        ],
        { kind: 'dataset', id: zonesId },
      ),
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json().inputDatasetIds.sort()).toEqual([incidentsId, zonesId].sort())
    const result = await runJob(created.json().jobId)
    const rows = await runQuery(
      query([{ type: 'sort', by: [{ field: 'name', dir: 'asc' }] }], {
        kind: 'dataset',
        id: result.datasetId,
      }),
      analyst,
    )
    expect(rows.map((row) => [row.name, Number(row.incidents), row.damage])).toEqual([
      ['Центр', 2, 300],
      ['Юг', 0, null],
    ])
  })

  it('права — на момент выполнения: без доступа к источнику запуск завершается ошибкой', async () => {
    if (!bus.listSubscribers().some((item) => item.name === 'data-analysis-failed')) {
      registerAnalysisBackground()
    }
    const created = await createAnalysis({
      name: `Буфер ${run}`,
      query: query([{ type: 'spatial', op: 'buffer', params: { distance: 500 } }]),
    })
    expect(created.statusCode, created.body).toBe(200)
    const { id, jobId } = created.json()

    // До выполнения аналитик теряет доступ к пространству с источником
    await db().transaction((tx) =>
      SpaceService.removeMember(tx, systemCtx('test'), fx.spaceId, analyst.id),
    )
    await redis().del(`kchs:principals:${analyst.id}`)
    await expect(runJob(jobId)).rejects.toThrow()

    const [row] = await db().execute<{ status: string; error: string | null }>(
      sql`SELECT status, error FROM analyses WHERE id = ${id}`,
    )
    expect(row?.status).toBe('failed')
    // Источник для аналитика больше не существует (права не раскрывают объект)
    expect(row?.error).toBe('Объект не найден')
    await db().transaction((tx) =>
      SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'editor'),
    )
    await redis().del(`kchs:principals:${analyst.id}`)
  })

  it('чужой не видит анализ, читатель не перезапускает', async () => {
    const hidden = await call(fx.app, { url: `/analyses/${analysisId}`, as: fx.users.stranger })
    expect(hidden.statusCode).toBe(404)
    const view = await call(fx.app, { url: `/analyses/${analysisId}`, as: fx.users.viewer })
    expect(view.statusCode, view.body).toBe(200)
    const rerun = await call(fx.app, {
      method: 'POST',
      url: `/analyses/${analysisId}/run`,
      as: fx.users.viewer,
    })
    expect(rerun.statusCode).toBe(403)
  })
})
