import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootTestApp, db, registerLifecycle, resetTestData } from './helpers.js'

/**
 * Загрузка истории ЧС (`kchs import-history`): каталог разбора исходников Комитета ложится
 * в пакет ЧС на чистой установке без оргструктуры. Повторный запуск ничего не дублирует,
 * исторические строки не запускают правила реестра (событий строк нет), а сами события
 * строк после загрузки снова включены.
 */
registerLifecycle()

const { runInit } = await import('../src/cli/init.js')
const { importHistory } = await import('../src/seed/history/index.js')
const { datasets, objects } = await import('../src/db-schema.js')

const PACK_KEY = sql<string>`coalesce(${objects.meta}->>'packKey', ${objects.meta}->>'systemKey')`

async function datasetByKey(
  key: string,
): Promise<{ id: string; table: string; settings: Record<string, unknown> }> {
  const [row] = await db()
    .select({ id: objects.id, table: datasets.physicalTable, settings: datasets.settings })
    .from(objects)
    .innerJoin(datasets, eq(datasets.id, objects.id))
    .where(and(isNull(objects.deletedAt), sql`${PACK_KEY} = ${`emergency.${key}`}`))
  if (!row) throw new Error(`нет датасета ${key}`)
  return row as { id: string; table: string; settings: Record<string, unknown> }
}

async function rows(table: string): Promise<Array<Record<string, unknown>>> {
  return db().execute<Record<string, unknown>>(
    sql`SELECT * FROM ${sql.identifier('ds')}.${sql.identifier(table)} WHERE _deleted_at IS NULL`,
  )
}

const LONG = `Рӯзи 30 майи соли 2022 бар асари боришоти пай дар пай ва омадани сел. ${'Тафсилот. '.repeat(130)}`

async function bundle(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kchs-history-'))
  await mkdir(path.join(dir, 'data'))
  await mkdir(path.join(dir, 'archive', 'Акты'), { recursive: true })
  const write = (file: string, value: unknown) =>
    writeFile(path.join(dir, file), JSON.stringify(value))
  await write('data/incident_types.json', [
    {
      code: 'FLOOD',
      name: 'Паводок, подъём уровня воды',
      name_tg: 'Баландшавии сатҳи об',
      group_name: 'Природные',
      report_category: 'Подъём уровня воды',
    },
    {
      code: 'SNOW',
      name: 'Сильный снегопад, морозы',
      name_tg: 'Боришоти барфи зиёд',
      group_name: 'Природные',
      report_category: 'Сильный снегопад, морозы',
    },
  ])
  const incident = (code: string, extra: Record<string, unknown>) => ({
    code,
    occurred_at: '2019-07-23T13:00:00+05:00',
    date_precision: 'day',
    type_code: 'FLOOD',
    type_raw: 'баландшавии сатҳи об',
    territory: 'TJ-SU-08',
    occurrences: 1,
    description: 'Подъём уровня воды',
    deaths: null,
    origin: 'Disaster 2019 .xlsx, лист «2019», строка 2',
    ...extra,
  })
  await write('data/incidents.json', [
    incident('H2019-0001', { deaths: 2, deaths_from_text: false }),
    incident('H2019-0002', { type_code: 'SNOW', date_precision: 'month', occurrences: 6 }),
    incident('H2022-D2022-012', {
      description: `${LONG.slice(0, 999)}…`,
      full_text: LONG,
      damage: 2585500,
    }),
  ])
  await write('data/damage.json', [
    {
      code: 'D2022-012',
      incident_code: 'H2022-D2022-012',
      event_date: '2022-05-30',
      date_precision: 'day',
      year: 2022,
      type_code: 'FLOOD',
      territory: 'TJ-SU-10',
      roads_km: 14,
      bridges: 13,
      damage: 2585500,
      text: LONG,
      origin: 'ЧС/2022.docx',
    },
  ])
  await write('data/stats.json', [
    { year: 2019, category: 'AV', category_name: 'Лавина', count: 445, deaths: 9, damage: null },
    {
      year: 2019,
      category: 'TOTAL',
      category_name: 'Всего',
      count: 681,
      deaths: 24,
      damage: 31357300,
    },
  ])
  await writeFile(path.join(dir, 'archive', 'Акты', '2022.docx'), 'акт')
  await write('manifest.json', {
    version: 1,
    title: 'История ЧС',
    data: {
      incident_types: 'data/incident_types.json',
      incidents: 'data/incidents.json',
      damage: 'data/damage.json',
      stats: 'data/stats.json',
    },
    layers: [],
    map: { name: 'Карта связи КЧС и ГО', camera: { center: [71.2, 38.7], zoom: 6 } },
    archive: [{ folder: 'Акты оценки ущерба', file: 'archive/Акты/2022.docx', name: '2022.docx' }],
    archiveRoot: 'Архив данных КЧС',
  })
  return dir
}

beforeAll(async () => {
  await bootTestApp()
  await resetTestData()
  await runInit({ adminLogin: 'admin', adminEmail: 'admin@example.tj' })
}, 120_000)

describe('загрузка истории ЧС', () => {
  it('ложится в пакет ЧС, повторный запуск ничего не дублирует, правила не запускаются', async () => {
    const dir = await bundle()
    const first = await importHistory(dir, { adminLogin: 'admin' })
    expect(first).toMatchObject({ incidents: 3, damage: 1, stats: 2, files: 1, layers: 0 })
    // Вид пакета уточнён, новый — добавлен
    expect(first.types).toEqual({ inserted: 1, updated: 1 })

    const incidents = await datasetByKey('dataset.incidents')
    const loaded = await rows(incidents.table)
    expect(loaded).toHaveLength(3)
    // События строк для правил на время загрузки выключены и вернулись
    expect(incidents.settings.rowEvents).toBe(true)
    const [events] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM ops.outbox
           WHERE type IN ('dataset.row_created', 'dataset.row_updated', 'dataset.row_deleted') AND event->'object'->>'id' = ${incidents.id}`,
    )
    expect(events?.total).toBe(0)

    const types = await datasetByKey('dataset.incident_types')
    const flood = (await rows(types.table)).find((row) => Object.values(row).includes('FLOOD'))
    expect(Object.values(flood ?? {})).toContain('Паводок, подъём уровня воды')
    expect(Object.values(flood ?? {})).toContain('Баландшавии сатҳи об')

    // Длинное описание — целиком в «Полном тексте», точка — центр района
    const long = loaded.find((row) => Object.values(row).includes('H2022-D2022-012'))
    expect(Object.values(long ?? {})).toContain(LONG)
    // Геометрия хранится EWKB: точка SRID 4326 начинается с 0101000020E6
    expect(
      loaded.every((row) =>
        Object.values(row).some((value) => String(value).startsWith('0101000020E6')),
      ),
    ).toBe(true)

    const again = await importHistory(dir, { adminLogin: 'admin' })
    expect(again).toMatchObject({ incidents: 0, damage: 0, stats: 0, files: 0 })
    expect(again.types.inserted).toBe(0)
    expect(await rows(incidents.table)).toHaveLength(3)
    expect(again.mapIds).toEqual(first.mapIds)
    expect(again.dashboardId).toBe(first.dashboardId)
  }, 180_000)
})
