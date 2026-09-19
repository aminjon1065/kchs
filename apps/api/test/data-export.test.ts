import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
 * Экспорт датасета (P1-E03 S04, ADR-0056): задание читает строки с политиками
 * запросившего на момент выполнения; файл скачивает только он. Тест выполняет
 * задание напрямую, как это сделал бы воркер очереди `exports`.
 */
registerLifecycle()

const { ExportService } = await import('../src/modules/data/domain/export-service.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { resetConfigCache } = await import('../src/shared/config/env.js')
const { s3, buckets } = await import('../src/kernel/storage/s3.js')

let fx: TestContext
let analyst: TestUser
let datasetId: string
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  // Аналитик: читатель пространства со способностью data.export
  analyst = await createUser(fx.app, 'analyst_test', ['employee', 'data_steward'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'viewer'),
  )
  await redis().del(`kchs:principals:${analyst.id}`)

  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Экспорт ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'phone', label: { ru: 'Телефон' }, type: 'text' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry', semantic: 'geometry' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        ['E-1', 'Хатлон', 10, [68.78, 37.83]],
        ['E-2', 'Хатлон', 20, [68.9, 37.9]],
        ['E-3', 'Согд', 30, [69.6, 40.28]],
        ['E-4', 'ГБАО', 40, null],
      ].map(([code, district, amount, point]) => ({
        values: {
          code,
          district,
          amount,
          phone: `+99290000${code}`,
          place: point ? { type: 'Point', coordinates: point } : null,
        },
      })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)

  const policies = [
    {
      url: 'rows',
      payload: {
        principal: { type: 'user', id: analyst.id },
        filter: { field: 'district', op: 'eq', value: 'Хатлон' },
      },
    },
    {
      url: 'columns',
      payload: { principal: { type: 'user', id: analyst.id }, mode: 'hide', fields: ['amount'] },
    },
    {
      url: 'columns',
      payload: { principal: { type: 'user', id: analyst.id }, mode: 'mask', fields: ['phone'] },
    },
  ]
  for (const policy of policies) {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/${policy.url}`,
      as: fx.admin,
      payload: policy.payload,
    })
    expect(response.statusCode, response.body).toBe(200)
  }
})

const startExport = (payload: Record<string, unknown>, as: TestUser = analyst) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/exports`, as, payload })

/** Выполняет задание, как воркер: данные задания из реестра, итог — в реестр. */
async function runJob(jobId: string) {
  const [row] = await db().execute<{ payload: Record<string, unknown> }>(
    sql`SELECT payload FROM jobs WHERE id = ${jobId}`,
  )
  const result = await ExportService.run(row?.payload as never, {
    recordId: jobId,
    progress: async () => undefined,
  })
  await JobService.finish(jobId, result)
  return result
}

async function download(jobId: string, as: TestUser = analyst) {
  const response = await call(fx.app, { url: `/datasets/exports/${jobId}/download`, as })
  expect(response.statusCode, response.body).toBe(200)
  const file = await fetch(response.json().url)
  expect(file.ok).toBe(true)
  return {
    text: await file.text(),
    disposition: file.headers.get('content-disposition') ?? '',
  }
}

describe('экспорт с политиками', () => {
  it('CSV содержит только строки аналитика, скрытого поля нет, телефон замаскирован', async () => {
    const started = await startExport({ format: 'csv' })
    expect(started.statusCode, started.body).toBe(200)
    const { jobId } = started.json()

    const result = await runJob(jobId)
    expect(result).toMatchObject({ format: 'csv', rows: 2, truncated: false })

    const { text, disposition } = await download(jobId)
    expect(disposition).toContain(encodeURIComponent(`Экспорт ${run}`))
    const lines = text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(lines[0]).toBe('Код,Район,Телефон,Место')
    expect(lines).toHaveLength(3)
    expect(lines.slice(1).every((line) => line.includes('Хатлон'))).toBe(true)
    expect(text).not.toContain('Согд')
    expect(text).not.toContain('+99290000')
    expect(text).toContain('***')
    // Геометрия в CSV — WKT: такой столбец импорт узнаёт снова (ADR-0068)
    expect(text).toContain('POINT (68.78 37.83)')

    const audit = await db().execute<{ details: Record<string, unknown> }>(
      sql`SELECT details FROM audit_log WHERE action = 'dataset.exported' AND object_id = ${datasetId}`,
    )
    expect(audit[0]?.details).toMatchObject({ format: 'csv', rows: 2, jobId })
  })

  it('поиск, сортировка и выбор полей — как в таблице; GeoJSON с геометрией', async () => {
    const started = await startExport({
      format: 'geojson',
      search: 'E-2',
      fields: ['code', 'place'],
    })
    expect(started.statusCode, started.body).toBe(200)
    await runJob(started.json().jobId)
    const parsed = JSON.parse((await download(started.json().jobId)).text)
    expect(parsed.features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [68.9, 37.9] },
        properties: { code: 'E-2' },
      },
    ])

    const sorted = await startExport({ format: 'json', sort: [{ field: 'code', dir: 'desc' }] })
    await runJob(sorted.json().jobId)
    const records = JSON.parse((await download(sorted.json().jobId)).text)
    expect(records.map((record: { code: string }) => record.code)).toEqual(['E-2', 'E-1'])
    expect(Object.keys(records[0])).not.toContain('amount')
  })

  it('политики — на момент выполнения, а не постановки', async () => {
    const started = await startExport({ format: 'json' })
    const policies = (
      await call(fx.app, { url: `/datasets/${datasetId}/policies`, as: fx.admin })
    ).json()
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/policies/rows/${policies.rows[0].id}`,
      as: fx.admin,
      payload: { filter: { field: 'district', op: 'eq', value: 'Согд' } },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    await runJob(started.json().jobId)
    const records = JSON.parse((await download(started.json().jobId)).text)
    expect(records.map((record: { district: string }) => record.district)).toEqual(['Согд'])

    // Вернуть «только Хатлон» для остальных проверок
    await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/policies/rows/${policies.rows[0].id}`,
      as: fx.admin,
      payload: { filter: { field: 'district', op: 'eq', value: 'Хатлон' } },
    })
  })

  it('XLSX: файл и число строк; владелец выгружает все строки', async () => {
    const own = await startExport({ format: 'xlsx' }, fx.admin)
    expect(own.statusCode, own.body).toBe(200)
    const result = await runJob(own.json().jobId)
    expect(result).toMatchObject({ format: 'xlsx', rows: 4, truncated: false })
    expect(result.size).toBeGreaterThan(0)
    expect(result.fileName.endsWith('.xlsx')).toBe(true)
  })
})

describe('права на экспорт', () => {
  it('без способности data.export — 403, постороннему — 404', async () => {
    expect((await startExport({ format: 'csv' }, fx.users.viewer)).statusCode).toBe(403)
    expect((await startExport({ format: 'csv' }, fx.users.stranger)).statusCode).toBe(404)
  })

  it('проверки при постановке: скрытое и неизвестное поле, GeoJSON без геометрии', async () => {
    const hidden = await startExport({ format: 'csv', fields: ['code', 'amount'] })
    expect(hidden.statusCode).toBe(400)
    const unknown = await startExport({ format: 'csv', fields: ['nope'] })
    expect(unknown.statusCode).toBe(400)
    const flat = await startExport({ format: 'geojson', fields: ['code'] })
    expect(flat.statusCode).toBe(400)
  })

  it('файл — только запросившему и только готовый', async () => {
    const started = await startExport({ format: 'csv' })
    const { jobId } = started.json()
    const early = await call(fx.app, { url: `/datasets/exports/${jobId}/download`, as: analyst })
    expect(early.statusCode).toBe(409)
    await runJob(jobId)
    for (const other of [fx.admin, fx.users.viewer]) {
      const response = await call(fx.app, { url: `/datasets/exports/${jobId}/download`, as: other })
      expect(response.statusCode).toBe(404)
    }
    // Чужое задание — не экспорт
    const foreign = await call(fx.app, {
      url: '/datasets/exports/00000000-0000-7000-8000-000000000000/download',
      as: analyst,
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('право отозвано до выполнения — задание не повторяется', async () => {
    const started = await startExport({ format: 'csv' })
    await db().transaction((tx) =>
      SpaceService.removeMember(tx, systemCtx('test'), fx.spaceId, analyst.id),
    )
    await redis().del(`kchs:principals:${analyst.id}`)
    await expect(runJob(started.json().jobId)).rejects.toMatchObject({
      name: 'UnrecoverableError',
    })
    await db().transaction((tx) =>
      SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'viewer'),
    )
    await redis().del(`kchs:principals:${analyst.id}`)
  })
})

describe('геоэкспорт через движок (ADR-0068)', () => {
  let engine: Server
  let received: {
    bucket: string
    sourceKey: string
    targetKey: string
    format: string
    layer: string
    contentType: string
    fields: Array<{ name: string; label: string; type: string }>
  } | null = null
  let features: Array<{ geometry: unknown; properties: Record<string, unknown> }> = []
  let replyStatus = 200
  const previousUrl = process.env.ENGINE_INTERNAL_URL

  beforeAll(async () => {
    // Движок: читает выгрузку воркера и кладёт файл формата по ключу результата
    engine = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        received = body
        const object = await s3().send(
          new GetObjectCommand({ Bucket: body.bucket, Key: body.sourceKey }),
        )
        const text = (await object.Body?.transformToString('utf-8')) ?? ''
        features = text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        if (replyStatus === 200) {
          await s3().send(
            new PutObjectCommand({
              Bucket: body.bucket,
              Key: body.targetKey,
              Body: 'SQLite format 3 (файл движка)',
              ContentType: body.contentType,
            }),
          )
        }
        response.statusCode = replyStatus
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify(
            replyStatus === 200 ? { rows: features.length, size: 40 } : { detail: 'Сбой GDAL' },
          ),
        )
      })
    })
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve))
    process.env.ENGINE_INTERNAL_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`
    resetConfigCache()
  })

  afterAll(async () => {
    process.env.ENGINE_INTERNAL_URL = previousUrl
    resetConfigCache()
    await new Promise((resolve) => engine.close(resolve))
  })

  it('GeoPackage: строки с политиками выгружает воркер, файл собирает движок', async () => {
    const started = await startExport({ format: 'gpkg' })
    expect(started.statusCode, started.body).toBe(200)
    const result = await runJob(started.json().jobId)
    expect(result).toMatchObject({ format: 'gpkg', rows: 2, size: 40, truncated: false })
    expect(result.fileName.endsWith('.gpkg')).toBe(true)
    expect(received).toMatchObject({
      bucket: buckets.exports(),
      format: 'gpkg',
      layer: `Экспорт ${run}`,
      contentType: 'application/geopackage+sqlite3',
      targetKey: result.key,
    })
    // Скрытого поля нет, геометрия — не свойство
    expect(received?.fields.map((field) => field.name)).toEqual(['code', 'district', 'phone'])
    expect(features).toHaveLength(2)
    expect(features.every((feature) => feature.properties.district === 'Хатлон')).toBe(true)
    expect(features.map((feature) => feature.geometry)).toContainEqual({
      type: 'Point',
      coordinates: [68.78, 37.83],
    })
    expect(JSON.stringify(features)).not.toContain('+99290000')
    // Выгрузка для движка удалена; файл — у запросившего
    await expect(
      s3().send(
        new HeadObjectCommand({ Bucket: buckets.exports(), Key: received?.sourceKey ?? '' }),
      ),
    ).rejects.toThrow()
    const { text } = await download(started.json().jobId)
    expect(text.startsWith('SQLite format 3')).toBe(true)
  })

  it('Shapefile — архив zip; без геометрии — 400; ошибка данных движка — без повтора', async () => {
    const shp = await startExport({ format: 'shp' })
    const result = await runJob(shp.json().jobId)
    expect(result.fileName.endsWith('.shp.zip')).toBe(true)
    expect(received?.contentType).toBe('application/zip')

    expect((await startExport({ format: 'shp', fields: ['code'] })).statusCode).toBe(400)
    replyStatus = 422
    const started = await startExport({ format: 'kml' })
    await expect(runJob(started.json().jobId)).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: 'Сбой GDAL',
    })
    replyStatus = 200
  })
})
