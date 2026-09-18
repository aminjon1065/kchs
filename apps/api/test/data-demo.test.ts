import { PutObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Демо-датасеты сида (P1-E10, ADR-0063): манифест генератора → датасеты со схемой,
 * справочниками, полями времени и территории → импорт тем же конвейером.
 * Движок имитируется: манифест и файлы уже в хранилище, нормализацию выполняет
 * тест по заданию импорта, загрузку — воркер (вызов напрямую).
 */
registerLifecycle()

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const { DemoData } = await import('../src/modules/data/public.js')
const { ImportService } = await import('../src/modules/data/domain/import-service.js')
const { TerritoryService } = await import('../src/modules/gis/public.js')
const { s3, buckets } = await import('../src/kernel/storage/s3.js')
const { systemCtx } = await import('../src/shared/context.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

let fx: TestContext
const run = Date.now().toString(36)
// Свой seed на прогон — свой префикс `demo/small-<seed>` в хранилище
const seed = 900_000 + Math.floor(Math.random() * 99_999)

const TYPES = {
  id: 'incident_types',
  file: 'incident_types.csv',
  name: `Типы происшествий ${run}`,
  kind: 'reference',
  description: 'Справочник типов',
  contentType: 'text/csv; charset=utf-8',
  rows: 2,
  key: ['code'],
  timeField: null,
  territoryField: null,
  geometryField: null,
  lookups: [],
  import: {
    options: { format: 'csv', encoding: 'utf-8', delimiter: ',', headerRows: 1 },
    mapping: [
      {
        column: 0,
        fieldKey: 'code',
        label: { ru: 'Код' },
        type: 'identifier',
        semantic: 'identifier',
        required: true,
      },
      {
        column: 1,
        fieldKey: 'name',
        label: { ru: 'Название' },
        type: 'text',
        semantic: 'dimension',
        required: true,
      },
    ],
    key: ['code'],
    onError: 'stop',
  },
}
const INCIDENTS = {
  id: 'incidents',
  file: 'incidents.csv',
  name: `Происшествия ${run}`,
  kind: 'table',
  description: 'Журнал происшествий',
  contentType: 'text/csv; charset=utf-8',
  rows: 3,
  key: ['code'],
  timeField: 'occurred_at',
  territoryField: 'territory',
  geometryField: null,
  lookups: [
    { field: 'type_code', dataset: 'incident_types', keyField: 'code', labelField: 'name' },
  ],
  import: {
    options: { format: 'csv', encoding: 'utf-8', delimiter: ',', headerRows: 1, dateOrder: 'ymd' },
    mapping: [
      {
        column: 0,
        fieldKey: 'code',
        label: { ru: 'Номер' },
        type: 'identifier',
        semantic: 'identifier',
        required: true,
      },
      {
        column: 1,
        fieldKey: 'occurred_at',
        label: { ru: 'Дата и время' },
        type: 'datetime',
        semantic: 'time',
        required: true,
      },
      {
        column: 2,
        fieldKey: 'type_code',
        label: { ru: 'Тип' },
        type: 'text',
        semantic: 'category',
        required: true,
      },
      {
        column: 3,
        fieldKey: 'territory',
        label: { ru: 'Территория' },
        type: 'territory',
        semantic: 'territory',
        required: true,
      },
    ],
    key: ['code'],
    onError: 'stop',
  },
}

/** Нормализованные строки, как их выдал бы движок: номер строки файла и значения. */
const NORMALIZED: Record<string, (territory: (code: string) => string) => string[]> = {
  'incident_types.csv': () => ['2,FL,Паводок', '3,MF,Сель'],
  'incidents.csv': (territory) =>
    variant === 1
      ? [
          `2,I-1,2025-03-01T10:00:00+05:00,FL,${territory('TJ-KT-01')}`,
          `3,I-2,2025-03-02T11:00:00+05:00,MF,${territory('TJ-KT-02')}`,
          `4,I-3,2025-04-01T09:30:00+05:00,FL,${territory('TJ-SU-01')}`,
        ]
      : [`2,J-1,2025-05-01T08:00:00+05:00,MF,${territory('TJ-SU-01')}`],
}
/** Данные «генератора»: другой seed — другие строки происшествий. */
let variant = 1

/** Файлы и манифест «генератора» под префиксом seed: манифест последним, как у движка. */
async function publish(seedValue: number): Promise<void> {
  const base = `demo/small-${seedValue}`
  await put(`${base}/incident_types.csv`, 'Код,Название\nFL,Паводок\nMF,Сель\n', 'text/csv')
  await put(`${base}/incidents.csv`, 'Номер,Дата и время,Тип,Территория\n', 'text/csv')
  await put(
    `${base}/manifest.json`,
    JSON.stringify({
      format: 'kchs-demo/1',
      profile: 'small',
      seed: seedValue,
      datasets: [TYPES, INCIDENTS],
    }),
    'application/json',
  )
}

async function put(key: string, body: string, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: buckets.files(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

/**
 * Движок: задания нормализации наших импортов → нормализованный CSV в хранилище
 * и отчёт внутренним маршрутом, затем загрузка воркером. Работает, пока сид ждёт.
 */
async function fakeEngine(signal: { done: boolean }): Promise<number> {
  let handled = 0
  const seen = new Set<string>()
  while (!signal.done) {
    const pending = await db().execute<{ id: string; payload: Record<string, unknown> }>(
      sql`SELECT i.id, j.payload FROM imports i
            JOIN jobs j ON j.id = i.job_id
            JOIN objects o ON o.id = i.dataset_id
           WHERE i.status = 'normalizing' AND o.title LIKE ${`% ${run}`}`,
    )
    for (const item of pending) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      const payload = item.payload as {
        fileName: string
        territories?: Record<string, string>
        output: { normalizedKey: string }
      }
      const territory = (code: string) => payload.territories?.[code.toLowerCase()] ?? ''
      const lines = NORMALIZED[payload.fileName]?.(territory) ?? []
      await put(payload.output.normalizedKey, `${lines.join('\n')}\n`, 'text/csv')
      const report = await call(fx.app, {
        method: 'POST',
        url: `/internal/data/imports/${item.id}/normalized`,
        payload: {
          jobRecordId: 'engine-job',
          rows: lines.length,
          errors: 0,
          normalizedKey: payload.output.normalizedKey,
          errorsKey: null,
          errorSample: [],
        },
        headers: { 'x-kchs-service-token': token },
      })
      expect(report.statusCode, report.body).toBe(200)
      await ImportService.load({ importId: item.id }, async () => undefined)
      handled += 1
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return handled
}

beforeAll(async () => {
  fx = await setupFixture()
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
  await TerritoryService.invalidate()
  await publish(seed)
})

describe('демо-датасеты сида', () => {
  it('справочник и таблица: схема, связи, территории, импорт; повтор ничего не грузит', async () => {
    const ctx = systemCtx('seed', { initiatorId: fx.admin.id })
    const signal = { done: false }
    const engine = fakeEngine(signal)
    const result = await DemoData.load(ctx, {
      profile: 'small',
      seed,
      spaceId: fx.spaceId,
      timeoutMs: 60_000,
    }).finally(() => {
      signal.done = true
    })
    expect(await engine).toBe(2)
    expect(result).toEqual({ datasets: 2, created: 2, rows: 5 })

    const found = await db().execute<{ id: string; demo: string }>(
      sql`SELECT id, meta->>'demo' AS demo FROM objects
           WHERE type = 'dataset' AND space_id = ${fx.spaceId} AND meta ? 'demo'
             AND title IN (${TYPES.name}, ${INCIDENTS.name})`,
    )
    const ids = Object.fromEntries(found.map((row) => [row.demo, row.id]))
    const types = (
      await call(fx.app, { url: `/datasets/${ids.incident_types}`, as: fx.admin })
    ).json()
    expect(types).toMatchObject({ kind: 'reference', rowCount: 2, primaryKey: ['code'] })

    const incidents = (
      await call(fx.app, { url: `/datasets/${ids.incidents}`, as: fx.admin })
    ).json()
    expect(incidents).toMatchObject({
      kind: 'table',
      rowCount: 3,
      timeField: 'occurred_at',
      territoryField: 'territory',
    })
    const fields = Object.fromEntries(
      (incidents.fields as Array<{ key: string }>).map((field) => [field.key, field]),
    )
    expect(fields.type_code).toMatchObject({
      lookup: { datasetId: ids.incident_types, keyField: 'code', labelField: 'name' },
      indexed: true,
    })
    expect(fields.territory).toMatchObject({ type: 'territory', indexed: true })

    // Файл набора — обычный файл пространства, строки — по справочнику территорий
    const summary = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: fx.admin,
      payload: {
        spec: {
          version: 1,
          source: { kind: 'dataset', id: ids.incidents },
          steps: [
            {
              type: 'compute',
              fields: [
                { name: 'region', expr: "territory_level(territory, 'region')" },
                { name: 'region_code', expr: 'territory_name(region)' },
                { name: 'kind', expr: 'lookup_label(type_code)' },
              ],
            },
            {
              type: 'aggregate',
              groupBy: [{ field: 'region_code' }, { field: 'kind' }],
              measures: [{ alias: 'n', agg: 'count' }],
            },
            {
              type: 'sort',
              by: [
                { field: 'region_code', dir: 'asc' },
                { field: 'kind', dir: 'asc' },
              ],
            },
          ],
        },
      },
    })
    expect(summary.statusCode, summary.body).toBe(200)
    expect(summary.json().rows).toEqual([
      ['Согдийская область', 'Паводок', 1],
      ['Хатлонская область', 'Паводок', 1],
      ['Хатлонская область', 'Сель', 1],
    ])

    // Повтор тем же профилем и seed: наборы найдены по отметке, новых импортов нет
    const again = await DemoData.load(ctx, { profile: 'small', seed, spaceId: fx.spaceId })
    expect(again).toEqual({ datasets: 2, created: 0, rows: 0 })
    const importsOf = async () =>
      (
        await db().execute<{ mode: string }>(
          sql`SELECT mode FROM imports
               WHERE dataset_id IN (${ids.incident_types}, ${ids.incidents}) ORDER BY created_at`,
        )
      ).map((row) => row.mode)
    expect(await importsOf()).toEqual(['append', 'append'])

    // Другой seed: те же датасеты, строки заменяются импортом «заменить»
    variant = 2
    await publish(seed + 1)
    const replaced = { done: false }
    const second = fakeEngine(replaced)
    const switched = await DemoData.load(ctx, {
      profile: 'small',
      seed: seed + 1,
      spaceId: fx.spaceId,
      timeoutMs: 60_000,
    }).finally(() => {
      replaced.done = true
    })
    expect(await second).toBe(2)
    expect(switched).toEqual({ datasets: 2, created: 0, rows: 3 })
    expect(await importsOf()).toEqual(['append', 'append', 'replace', 'replace'])
    const after = (await call(fx.app, { url: `/datasets/${ids.incidents}`, as: fx.admin })).json()
    expect(after.rowCount).toBe(1)
  })
})
