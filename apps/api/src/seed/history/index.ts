import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type ChartSpec,
  DashboardCreateInput,
  type DashboardTile,
  DatasetCreateInput,
  type DatasetFieldInput,
  DatasetRowsBatch,
  ImportRunInput,
  type LangText,
  LayerStyle,
  type MapLayerEntry,
  MapSpec,
  type QuerySpec,
} from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { bootstrapPlatform } from '~/bootstrap.js'
import { JobService } from '~/kernel/jobs/service.js'
import { putObject, storageKey } from '~/kernel/storage/s3.js'
import { DatasetService } from '~/modules/data/domain/dataset-service.js'
import { ImportService } from '~/modules/data/domain/import-service.js'
import { RowService } from '~/modules/data/domain/row-service.js'
import { applyRowsBatch } from '~/modules/data/domain/rows-batch.js'
import { SchemaService } from '~/modules/data/domain/schema-service.js'
import { columnSql, tableSql } from '~/modules/data/infra/physical.js'
import { Dashboards } from '~/modules/data/public.js'
import { FileService } from '~/modules/files/domain/file-service.js'
import { registerStoredFile } from '~/modules/files/public.js'
import { BasemapService } from '~/modules/gis/domain/basemap-service.js'
import { LayerService } from '~/modules/gis/domain/layer-service.js'
import { MapService } from '~/modules/gis/domain/map-service.js'
import { TerritoryService } from '~/modules/territories/public.js'
import { db } from '~/shared/db/client.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { seedCommand } from '../command.js'
import {
  findPackObject,
  markPackObject,
  type PackContext,
  packContext,
} from '../packs/emergency/context.js'
import { ensureDatasets } from '../packs/emergency/datasets.js'
import { installEmergencyPack } from '../packs/emergency/index.js'

/**
 * Загрузка истории ЧС Комитета (1988–2026) — `kchs import-history <каталог>`.
 *
 * Каталог собирает разбор исходников Комитета (таблицы Disaster, акты ущерба, сводка «10 сола»,
 * геобаза ArcGIS): `manifest.json`, `data/*.json`, `gis/*.gpkg`, `archive/**`. Данные ложатся в
 * пакет ЧС: классификатор и реестр «Происшествия», а рядом — «Оценка ущерба», «Статистика ЧС
 * (10 сола)», слои и карты, дашборд, архив исходных файлов. Повторный запуск досоздаёт только
 * недостающее: объекты находятся по ключам пакета, строки — по первичным ключам.
 */

const Manifest = z.object({
  version: z.literal(1),
  title: z.string(),
  data: z.object({
    incident_types: z.string(),
    incidents: z.string(),
    damage: z.string(),
    stats: z.string(),
  }),
  layers: z.array(
    z.object({
      key: z.string().regex(/^[a-z_]+$/),
      file: z.string(),
      layer: z.string(),
      name: z.string(),
      visible: z.boolean(),
      style: z.record(z.string(), z.unknown()),
    }),
  ),
  map: z.object({
    name: z.string(),
    camera: z.object({ center: z.tuple([z.number(), z.number()]), zoom: z.number() }),
  }),
  archive: z.array(z.object({ folder: z.string(), file: z.string(), name: z.string() })),
  archiveRoot: z.string(),
})
type Manifest = z.infer<typeof Manifest>
type Row = Record<string, unknown>

export interface HistoryImportResult {
  types: { inserted: number; updated: number }
  incidents: number
  damage: number
  stats: number
  layers: number
  files: number
  mapIds: string[]
  dashboardId: string | null
}

const ru = (text: string): LangText => ({ ru: text })

function field(
  key: string,
  label: string,
  type: DatasetFieldInput['type'],
  semantic: string,
  extra: Partial<DatasetFieldInput> = {},
): DatasetFieldInput {
  return {
    key,
    label: ru(label),
    type,
    semantic,
    required: false,
    unique: false,
    indexed: false,
    sensitive: false,
    readOnly: false,
    nullable: !extra.required,
    order: 0,
    ...extra,
  } as DatasetFieldInput
}

const PRECISION = field('date_precision', 'Точность даты', 'select', 'category', {
  options: [
    { value: 'day', label: ru('День') },
    { value: 'month', label: ru('Месяц') },
    { value: 'year', label: ru('Только год') },
  ],
} as Partial<DatasetFieldInput>)

/** Поля истории в «Происшествиях»: то, чего нет в схеме пакета, но есть в источниках. */
const INCIDENT_HISTORY_FIELDS: DatasetFieldInput[] = [
  PRECISION,
  field('date_text', 'Дата в источнике', 'text', 'text'),
  field('occurrences', 'Количество явлений', 'integer', 'measure'),
  field('type_raw', 'Вид в источнике', 'text', 'text'),
  field('place', 'Место (джамоат, село)', 'text', 'text'),
  field('rescued', 'Спасено, чел.', 'integer', 'measure'),
  field('bodies_recovered', 'Извлечено тел', 'integer', 'measure'),
  field('rescue_team', 'Выезд спасательной группы', 'boolean', 'category'),
  field('deaths_from_text', 'Погибшие — из описания', 'boolean', 'category'),
  field('affected_text', 'Пострадавшее население (как в источнике)', 'long_text', 'text'),
  field('damage_raw', 'Ущерб (как в источнике)', 'text', 'text'),
  field('needs_raw', 'Потребности (как в источнике)', 'text', 'text'),
  field('info_source', 'Источник сведений', 'text', 'text'),
  field('legacy_code', 'Код в источнике (001/002)', 'text', 'category'),
  field('territory_note', 'Замечание о месте', 'text', 'text'),
  field('full_text', 'Полный текст', 'long_text', 'text'),
  field('origin', 'Откуда строка', 'text', 'text'),
]

const TYPE_FIELDS: DatasetFieldInput[] = [
  field('name_tg', 'Название на таджикском', 'text', 'text'),
  field('report_category', 'Категория сводки «10 сола»', 'text', 'category'),
]

const DAMAGE_FIELDS: DatasetFieldInput[] = [
  field('code', 'Номер акта', 'identifier', 'identifier', { required: true }),
  field('event_date', 'Дата бедствия', 'date', 'time', { format: { dateFormat: 'dd.MM.yyyy' } }),
  PRECISION,
  field('year', 'Год', 'integer', 'dimension'),
  field('type_code', 'Вид', 'text', 'category'),
  field('cause', 'Причина (как в акте)', 'text', 'text'),
  field('territory', 'Территория', 'territory', 'territory'),
  field('place_raw', 'Место в акте', 'text', 'text'),
  field('incident_code', 'Происшествие', 'text', 'identifier'),
  field('decision_date', 'Дата решения комиссии', 'date', 'time', {
    format: { dateFormat: 'dd.MM.yyyy' },
  }),
  field('decision_no', 'Номер решения', 'text', 'identifier'),
  field('houses', 'Жилых домов', 'integer', 'measure'),
  field('houses_destroyed', 'Из них полностью', 'integer', 'measure'),
  field('schools', 'Школ и детсадов', 'integer', 'measure'),
  field('medical', 'Медучреждений', 'integer', 'measure'),
  field('bridges', 'Мостов', 'integer', 'measure'),
  field('roads_km', 'Дорог, км', 'number', 'measure', { format: { precision: 2 } }),
  field('power_km', 'ЛЭП, км', 'number', 'measure', { format: { precision: 2 } }),
  field('canals_km', 'Каналов и арыков, км', 'number', 'measure', { format: { precision: 2 } }),
  field('livestock', 'Голов скота', 'integer', 'measure'),
  field('deaths', 'Погибших', 'integer', 'measure'),
  field('damage', 'Ущерб, сомони', 'money', 'measure', {
    format: { precision: 2, currency: 'TJS', thousands: true },
  }),
  field('damage_text', 'Итог в акте', 'text', 'text'),
  field('territory_note', 'Замечание о месте', 'text', 'text'),
  field('text', 'Текст акта', 'long_text', 'text'),
  field('origin', 'Документ', 'text', 'text'),
]

const STATS_FIELDS: DatasetFieldInput[] = [
  field('year', 'Год', 'integer', 'dimension', { required: true }),
  field('category', 'Код категории', 'text', 'identifier', { required: true }),
  field('category_name', 'Категория', 'text', 'category'),
  field('count', 'Количество ЧС', 'integer', 'measure'),
  field('deaths', 'Погибших', 'integer', 'measure'),
  field('damage', 'Ущерб, сомони', 'money', 'measure', {
    format: { precision: 2, currency: 'TJS', thousands: true },
  }),
]

async function readJson<T>(dir: string, file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dir, file), 'utf8')) as T
}

/** Значения ключевого поля живых строк: какие строки уже загружены. */
async function existingKeys(datasetId: string, keys: string[]): Promise<Map<string, string>> {
  const storage = await DatasetService.storage(datasetId)
  const columns = keys.map((key) => {
    const item = storage.fields.find((f) => f.key === key)
    if (!item) throw new Error(`В датасете нет поля ${key}`)
    return columnSql(item.physical)
  })
  const rows = await db().execute<{ id: string; key: string }>(
    sql`SELECT _id::text AS id, concat_ws('|', ${sql.join(columns, sql`, `)}) AS key
          FROM ${tableSql(storage.table)} WHERE _deleted_at IS NULL`,
  )
  return new Map(rows.map((row) => [row.key, row.id]))
}

async function ensureFields(
  pack: PackContext,
  datasetId: string,
  fields: DatasetFieldInput[],
): Promise<string[]> {
  const storage = await DatasetService.storage(datasetId)
  const have = new Set(storage.fields.map((f) => f.key))
  const added: string[] = []
  await db().transaction(async (tx) => {
    for (const item of fields) {
      if (have.has(item.key)) continue
      await SchemaService.addField(tx, pack.ctx, datasetId, item)
      added.push(item.key)
    }
  })
  return added
}

async function insertMissing(
  pack: PackContext,
  datasetId: string,
  rows: Row[],
  keys: string[],
): Promise<number> {
  const keyOf = (row: Row) => keys.map((k) => String(row[k] ?? '')).join('|')
  // Дубли ключа в самом каталоге — ошибка разбора: до записи, с номерами строк
  const seen = new Set<string>()
  const doubled = rows.map(keyOf).filter((key) => seen.has(key) || !seen.add(key))
  if (doubled.length > 0) {
    throw new Error(
      `Повторяются ключи ${keys.join(', ')}: ${[...new Set(doubled)].slice(0, 10).join('; ')}`,
    )
  }
  const existing = await existingKeys(datasetId, keys)
  const fresh = rows.filter((row) => !existing.has(keyOf(row)))
  let inserted = 0
  for (let at = 0; at < fresh.length; at += 500) {
    const chunk = fresh.slice(at, at + 500).map((values) => ({ values }))
    inserted += (await RowService.insert(pack.ctx, datasetId, chunk)).length
  }
  return inserted
}

async function ensureDataset(
  pack: PackContext,
  key: string,
  spec: {
    name: string
    description: string
    fields: DatasetFieldInput[]
    primaryKey: string[]
    timeField?: string
    territoryField?: string
  },
): Promise<string> {
  const found = await findPackObject('dataset', key)
  if (found) {
    await ensureFields(pack, found, spec.fields)
    return found
  }
  const input = DatasetCreateInput.parse({
    name: spec.name,
    description: spec.description,
    spaceId: pack.orgSpaceId,
    kind: 'table',
    fields: spec.fields,
    primaryKey: spec.primaryKey,
    timeField: spec.timeField ?? null,
    territoryField: spec.territoryField ?? null,
    settings: { rowEvents: false },
  })
  return db().transaction(async (tx) => {
    const id = await DatasetService.create(tx, pack.ctx, input)
    await markPackObject(tx, pack.ctx, id, key)
    return id
  })
}

// ── Классификатор и реестр ──────────────────────────────────────────────────

async function loadTypes(pack: PackContext, datasetId: string, rows: Row[]) {
  await ensureFields(pack, datasetId, TYPE_FIELDS)
  const existing = await existingKeys(datasetId, ['code'])
  const insert = rows.filter((row) => !existing.has(String(row.code))).map((values) => ({ values }))
  // Виды пакета получают уточнённые названия, таджикское имя и категорию сводки
  const update = rows
    .filter((row) => existing.has(String(row.code)))
    .map((row) => ({ id: existing.get(String(row.code)) as string, values: row }))
  await applyRowsBatch(pack.ctx, datasetId, DatasetRowsBatch.parse({ insert, update }))
  return { inserted: insert.length, updated: update.length }
}

async function loadIncidents(pack: PackContext, datasetId: string, rows: Row[]): Promise<number> {
  await ensureFields(pack, datasetId, INCIDENT_HISTORY_FIELDS)
  const centroids = new Map<string, { lon: number; lat: number }>()
  for (const item of await TerritoryService.list()) {
    if (item.centroid) centroids.set(item.code, item.centroid)
  }
  const values = rows.map((row) => {
    const center = centroids.get(String(row.territory))
    return {
      ...row,
      source: 'import',
      // Места точнее района в источниках нет: точка — центр района (ADR-0157)
      location_approx: true,
      lat: center?.lat ?? null,
      lon: center?.lon ?? null,
      geometry: center ? { type: 'Point', coordinates: [center.lon, center.lat] } : null,
    }
  })
  // Историческая загрузка не должна запускать правила реестра (уведомления, поручения
  // о погибших): события строк на время загрузки выключены и возвращаются после неё
  const storage = await DatasetService.storage(datasetId)
  const rowEvents = storage.settings.rowEvents === true
  if (rowEvents) {
    await db().transaction((tx) =>
      SchemaService.update(tx, pack.ctx, datasetId, { settings: { rowEvents: false } }),
    )
  }
  try {
    return await insertMissing(pack, datasetId, values, ['code'])
  } finally {
    if (rowEvents) {
      await db().transaction((tx) =>
        SchemaService.update(tx, pack.ctx, datasetId, { settings: { rowEvents: true } }),
      )
    }
  }
}

// ── Архив файлов ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.jpg': 'image/jpeg',
  '.zip': 'application/zip',
  '.gpkg': 'application/geopackage+sqlite3',
  '.mxd': 'application/octet-stream',
  '.bak': 'application/octet-stream',
}

async function ensureFolder(pack: PackContext, key: string, name: string, parentId: string | null) {
  const found = await findPackObject('folder', key)
  if (found) return found
  return db().transaction(async (tx) => {
    const folder = await FileService.createFolder(tx, pack.ctx, {
      name,
      spaceId: pack.orgSpaceId,
      parentId,
    })
    await markPackObject(tx, pack.ctx, folder.id, key)
    return folder.id
  })
}

const hashKey = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16)

async function uploadFile(
  pack: PackContext,
  dir: string,
  file: string,
  name: string,
  folderId: string,
): Promise<{ id: string; created: boolean }> {
  const key = `history.file.${hashKey(file)}`
  const found = await findPackObject('file', key)
  if (found) return { id: found, created: false }
  const body = await readFile(path.join(dir, file))
  const sourceKey = storageKey(pack.orgSpaceId, newId(), newId(), name)
  await putObject(sourceKey, body, {
    contentType: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    contentLength: body.length,
  })
  const record = await registerStoredFile(pack.ctx, {
    spaceId: pack.orgSpaceId,
    folderId,
    name,
    mime: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    sourceKey,
  })
  await db().transaction((tx) => markPackObject(tx, pack.ctx, record.id, key))
  return { id: record.id, created: true }
}

// ── Слои и карты ────────────────────────────────────────────────────────────

async function waitImport(importId: string, jobId: string | null, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = await ImportService.get(importId)
    if (['succeeded', 'failed', 'cancelled', 'review'].includes(record.status)) return record
    if (jobId) {
      const job = await JobService.get(jobId)
      if (job && (job.status === 'failed' || job.status === 'cancelled')) {
        throw new Error(`задание импорта ${job.status}: ${job.error ?? ''}`)
      }
    }
    if (Date.now() > deadline)
      throw new Error(`импорт ${importId} не закончился за ${timeoutMs / 1000} с`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

/** Геофайл слоя → новый датасет через обычный импорт (движок нормализует, worker грузит). */
async function importLayer(
  pack: PackContext,
  dir: string,
  layer: Manifest['layers'][number],
  folderId: string,
): Promise<string> {
  const key = `history.layer-dataset.${layer.key}`
  const found = await findPackObject('dataset', key)
  if (found) return found
  const file = await uploadFile(pack, dir, layer.file, `${layer.key}.gpkg`, folderId)
  const analysis = await ImportService.analyze({
    fileId: file.id,
    options: { format: 'gpkg', layer: layer.layer },
  })
  const input = ImportRunInput.parse({
    fileId: file.id,
    options: {
      format: analysis.format,
      skipRows: analysis.skipRows,
      headerRows: analysis.headerRows,
      ...(analysis.geo?.layer ? { layer: analysis.geo.layer } : { layer: layer.layer }),
    },
    target: { kind: 'new', name: layer.name, spaceId: pack.orgSpaceId },
    mapping: analysis.columns
      .filter((column) => column.emptyShare < 1 && column.key !== 'geometry')
      .map((column) => ({
        column: column.index,
        fieldKey: column.key,
        label: ru(column.name || column.key),
        type: column.type,
        semantic: column.semantic,
        ...(column.format ? { format: column.format } : {}),
        required: false,
      })),
    geometry: analysis.geometry,
    geometryField: 'geometry',
    key: [],
    onError: 'skip',
    review: false,
  })
  const record = await db().transaction((tx) => ImportService.start(tx, pack.ctx, input))
  if (record.jobId) await JobService.dispatch(record.jobId)
  const done = await waitImport(record.id, record.jobId, 15 * 60_000)
  if (done.status !== 'succeeded' || !done.datasetId) {
    throw new Error(
      `слой «${layer.name}»: ${done.message ?? done.errorSample[0]?.reason ?? done.status}`,
    )
  }
  await db().transaction((tx) => markPackObject(tx, pack.ctx, done.datasetId as string, key))
  return done.datasetId
}

/** Оформление слоя под поля датасета: подписи и поля карточки, которых нет (пустые в
 * источнике — импорт их не заводит), отбрасываются. */
async function fitStyle(
  datasetId: string,
  style: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storage = await DatasetService.storage(datasetId)
  const keys = new Set(storage.fields.map((item) => item.key))
  const result = { ...style }
  const label = result.label as { field?: string | null } | undefined
  if (label?.field && !keys.has(label.field)) result.label = null
  const popup = result.popup as { title: string; fields: string[] } | undefined
  if (popup) {
    const fields = popup.fields.filter((key) => keys.has(key))
    const title = popup.title.replace(/\{\{(\w+)\}\}/g, (all, key: string) =>
      keys.has(key) ? all : '',
    )
    result.popup = { ...popup, fields, title: title.trim() || 'Объект' }
  }
  return result
}

/** Категории точек сети связи — по видам оборудования, что есть в данных. */
async function categoriesOf(datasetId: string, fieldKey: string) {
  const storage = await DatasetService.storage(datasetId)
  const item = storage.fields.find((f) => f.key === fieldKey)
  if (!item) return []
  const rows = await db().execute<{ value: string }>(
    sql`SELECT DISTINCT ${columnSql(item.physical)}::text AS value FROM ${tableSql(storage.table)}
         WHERE _deleted_at IS NULL AND ${columnSql(item.physical)} IS NOT NULL ORDER BY 1 LIMIT 12`,
  )
  return rows.map((row, index) => ({
    value: row.value,
    label: ru(row.value),
    color: `categorical.${index + 1}`,
  }))
}

async function ensureLayer(
  pack: PackContext,
  key: string,
  name: string,
  datasetId: string,
  style: Record<string, unknown>,
): Promise<string> {
  const found = await findPackObject('layer', key)
  if (found) return found
  return db().transaction(async (tx) => {
    const id = await LayerService.create(tx, pack.ctx, {
      name,
      spaceId: pack.orgSpaceId,
      datasetId,
      style: LayerStyle.parse(style),
      editable: false,
      moderated: false,
    })
    await markPackObject(tx, pack.ctx, id, key)
    return id
  })
}

async function ensureMap(
  pack: PackContext,
  key: string,
  name: string,
  layers: MapLayerEntry[],
  camera: { center: [number, number]; zoom: number },
): Promise<string> {
  const found = await findPackObject('map', key)
  if (found) return found
  const basemap = (await BasemapService.list(pack.ctx)).find((item) => item.isDefault)
  return db().transaction(async (tx) => {
    const id = await MapService.create(tx, pack.ctx, {
      name,
      spaceId: pack.orgSpaceId,
      parentId: null,
      spec: MapSpec.parse({
        basemapId: basemap?.id ?? null,
        layers,
        camera: { ...camera, bearing: 0, pitch: 0 },
      }),
    })
    await markPackObject(tx, pack.ctx, id, key)
    return id
  })
}

/** Происшествия истории на карте: виды — цветом, точки — в кластерах. */
function incidentStyle(): Record<string, unknown> {
  const kinds: Array<[string, string, string]> = [
    ['MUDFLOW', 'Сель', 'categorical.5'],
    ['EARTHQUAKE', 'Землетрясение', 'danger'],
    ['AVALANCHE', 'Лавина', 'info'],
    ['FLOOD', 'Паводок', 'categorical.1'],
    ['LANDSLIDE', 'Оползень', 'categorical.6'],
    ['ROCKFALL', 'Камнепад', 'categorical.7'],
    ['STORM', 'Сильный ветер', 'categorical.4'],
    ['HAIL', 'Ливни, град', 'categorical.2'],
    ['SNOW', 'Снегопад, мороз', 'categorical.8'],
    ['DROWNING', 'Утопление', 'categorical.3'],
    ['ROAD', 'ДТП', 'warning'],
  ]
  return {
    version: 1,
    geometry: 'point',
    renderer: {
      kind: 'categorized',
      field: 'type_code',
      categories: kinds.map(([value, label, color]) => ({ value, label: ru(label), color })),
      other: { color: 'neutral', label: ru('Прочие') },
    },
    point: { shape: 'circle', size: 7 },
    cluster: { enabled: true, radius: 40, maxZoom: 9 },
    popup: {
      title: '{{type_raw}}',
      fields: [
        'occurred_at',
        'type_code',
        'territory',
        'deaths',
        'injured',
        'damage',
        'description',
      ],
      actions: [],
    },
  }
}

// ── Дашборд ─────────────────────────────────────────────────────────────────

const source = (id: string, alias: string) => ({ kind: 'dataset' as const, id, alias })

function chart(
  type: 'bar' | 'line' | 'table',
  query: unknown,
  x: { field: string; label: string; type: 'nominal' | 'quantitative' | 'temporal' },
  y: Array<{ field: string; label: string }>,
  options: Record<string, unknown> = {},
  color?: { field: string; label: string },
): ChartSpec {
  return {
    version: 1,
    type,
    data: { query },
    encoding: {
      x: { field: x.field, type: x.type, label: ru(x.label) },
      y: y.map((item) => ({
        field: item.field,
        type: 'quantitative',
        label: ru(item.label),
        axis: 'left',
      })),
      ...(color ? { color: { field: color.field, type: 'nominal', label: ru(color.label) } } : {}),
      tooltip: [],
    },
    options,
  } as unknown as ChartSpec
}

function tile(
  id: string,
  title: string,
  spec: ChartSpec,
  x: number,
  y: number,
  w: number,
  h: number,
): DashboardTile {
  return { id, kind: 'chart', title, spec, filterBindings: {}, x, y, w, h } as DashboardTile
}

function statsBy(
  statsId: string,
  measure: 'count' | 'deaths' | 'damage',
  byCategory: boolean,
): QuerySpec {
  return {
    version: 1,
    source: source(statsId, 's'),
    steps: [
      {
        type: 'filter',
        where: byCategory
          ? { field: 's.category', op: 'neq', value: 'TOTAL' }
          : { field: 's.category', op: 'eq', value: 'TOTAL' },
      },
      {
        type: 'aggregate',
        groupBy: [
          { field: 's.year', alias: 'year' },
          ...(byCategory ? [{ field: 's.category_name', alias: 'category' }] : []),
        ],
        measures: [{ alias: measure, agg: 'sum', field: `s.${measure}` }],
      },
      { type: 'sort', by: [{ field: 'year', dir: 'asc' }] },
    ],
  } as unknown as QuerySpec
}

function registryByYear(incidentsId: string): QuerySpec {
  return {
    version: 1,
    source: source(incidentsId, 'inc'),
    steps: [
      {
        type: 'aggregate',
        groupBy: [{ field: 'inc.occurred_at', bucket: 'year', alias: 'year' }],
        measures: [
          { alias: 'incidents', agg: 'sum', field: 'inc.occurrences' },
          { alias: 'deaths', agg: 'sum', field: 'inc.deaths' },
        ],
      },
      { type: 'sort', by: [{ field: 'year', dir: 'asc' }] },
    ],
  } as unknown as QuerySpec
}

function registryByKind(incidentsId: string, typesId: string): QuerySpec {
  return {
    version: 1,
    source: source(incidentsId, 'inc'),
    steps: [
      {
        type: 'join',
        source: source(typesId, 'kinds'),
        on: [{ left: 'inc.type_code', right: 'kinds.code' }],
        kind: 'left',
      },
      {
        type: 'aggregate',
        groupBy: [{ field: 'kinds.name', alias: 'kind' }],
        measures: [
          { alias: 'incidents', agg: 'sum', field: 'inc.occurrences' },
          { alias: 'deaths', agg: 'sum', field: 'inc.deaths' },
        ],
      },
      { type: 'sort', by: [{ field: 'incidents', dir: 'desc' }] },
      { type: 'limit', limit: 15, offset: 0 },
    ],
  } as unknown as QuerySpec
}

function registryByRegion(incidentsId: string): QuerySpec {
  return {
    version: 1,
    source: source(incidentsId, 'inc'),
    steps: [
      {
        type: 'compute',
        fields: [
          { name: 'region', expr: "territory_level(inc.territory, 'region')", type: 'territory' },
        ],
      },
      {
        type: 'aggregate',
        groupBy: [{ field: 'region', alias: 'region' }],
        measures: [
          { alias: 'incidents', agg: 'sum', field: 'inc.occurrences' },
          { alias: 'deaths', agg: 'sum', field: 'inc.deaths' },
          { alias: 'damage', agg: 'sum', field: 'inc.damage' },
        ],
      },
      { type: 'sort', by: [{ field: 'incidents', dir: 'desc' }] },
    ],
  } as unknown as QuerySpec
}

async function ensureDashboard(
  pack: PackContext,
  ids: { stats: string; incidents: string; types: string; mapId: string },
): Promise<string> {
  const key = 'history.dashboard'
  const found = await findPackObject('dashboard', key)
  if (found) return found
  const tiles: DashboardTile[] = [
    {
      id: 'title',
      kind: 'heading',
      text: 'Официальная статистика (сводка «10 сола»)',
      filterBindings: {},
      x: 0,
      y: 0,
      w: 12,
      h: 1,
    } as DashboardTile,
    tile(
      'official-count',
      'ЧС по годам и категориям',
      chart(
        'bar',
        statsBy(ids.stats, 'count', true),
        { field: 'year', label: 'Год', type: 'nominal' },
        [{ field: 'count', label: 'ЧС' }],
        { stacked: true },
        { field: 'category', label: 'Категория' },
      ),
      0,
      1,
      8,
      5,
    ),
    tile(
      'official-deaths',
      'Погибшие по годам',
      chart(
        'bar',
        statsBy(ids.stats, 'deaths', false),
        { field: 'year', label: 'Год', type: 'nominal' },
        [{ field: 'deaths', label: 'Погибшие' }],
      ),
      8,
      1,
      4,
      5,
    ),
    tile(
      'official-damage',
      'Ущерб по годам, сомони',
      chart(
        'bar',
        statsBy(ids.stats, 'damage', false),
        { field: 'year', label: 'Год', type: 'nominal' },
        [{ field: 'damage', label: 'Ущерб' }],
      ),
      0,
      6,
      12,
      4,
    ),
    {
      id: 'title-registry',
      kind: 'heading',
      text: 'Реестр происшествий 1988–2026',
      filterBindings: {},
      x: 0,
      y: 10,
      w: 12,
      h: 1,
    } as DashboardTile,
    tile(
      'registry-years',
      'События и погибшие по годам (реестр)',
      chart(
        'bar',
        registryByYear(ids.incidents),
        { field: 'year', label: 'Год', type: 'temporal' },
        [
          { field: 'incidents', label: 'События' },
          { field: 'deaths', label: 'Погибшие' },
        ],
      ),
      0,
      11,
      8,
      5,
    ),
    tile(
      'registry-kinds',
      'Чаще всего (реестр)',
      chart(
        'table',
        registryByKind(ids.incidents, ids.types),
        { field: 'kind', label: 'Вид', type: 'nominal' },
        [
          { field: 'incidents', label: 'События' },
          { field: 'deaths', label: 'Погибшие' },
        ],
      ),
      8,
      11,
      4,
      5,
    ),
    tile(
      'registry-regions',
      'По областям (реестр)',
      chart(
        'table',
        registryByRegion(ids.incidents),
        { field: 'region', label: 'Область', type: 'nominal' },
        [
          { field: 'incidents', label: 'События' },
          { field: 'deaths', label: 'Погибшие' },
          { field: 'damage', label: 'Ущерб, сомони' },
        ],
      ),
      0,
      16,
      5,
      5,
    ),
    {
      id: 'map',
      kind: 'map',
      title: 'История ЧС на карте',
      mapId: ids.mapId,
      map: { camera: null, bindings: {} },
      filterBindings: {},
      x: 5,
      y: 16,
      w: 7,
      h: 8,
    } as DashboardTile,
  ]
  return db().transaction((tx) =>
    Dashboards.create(
      tx,
      pack.ctx,
      DashboardCreateInput.parse({
        name: 'История и статистика ЧС',
        spaceId: pack.orgSpaceId,
        spec: { tiles, filters: [], refreshInterval: null, theme: 'auto' },
      }),
      { systemKey: `emergency.${key}` },
    ),
  )
}

// ── Точка входа ─────────────────────────────────────────────────────────────

export async function importHistory(
  dir: string,
  options: { adminLogin: string },
): Promise<HistoryImportResult> {
  const log = logger().child({ module: 'seed', pack: 'emergency', step: 'history' })
  const manifest = Manifest.parse(await readJson(dir, 'manifest.json'))
  const say = (message: string, details: Record<string, unknown> = {}) => log.info(details, message)

  // Типы объектов и системные роли — как у `kchs seed`: команда идёт отдельным процессом
  await bootstrapPlatform()
  // Привязка к районам требует справочника территорий: сразу после `kchs init` его ещё нет
  if ((await TerritoryService.list()).length === 0) {
    await seedCommand({ profile: 'base', reset: false })
    await TerritoryService.invalidate()
  }
  // Пакет ЧС: реестры, классификатор, карта и дашборды штаба — без демо-строк
  const installed = await installEmergencyPack(options.adminLogin, { demo: false })
  const base = await packContext(options.adminLogin, { demo: false }, say)
  const pack: PackContext = { ...base, spaceId: installed.spaceId }
  const datasets = await ensureDatasets(pack)
  const typesId = datasets.get('incident_types') as string
  const incidentsId = datasets.get('incidents') as string

  const types = await loadTypes(
    pack,
    typesId,
    await readJson<Row[]>(dir, manifest.data.incident_types),
  )
  say('классификатор видов', types)
  const incidents = await loadIncidents(
    pack,
    incidentsId,
    await readJson<Row[]>(dir, manifest.data.incidents),
  )
  say('реестр происшествий', { inserted: incidents })

  const damageId = await ensureDataset(pack, 'history.dataset.damage', {
    name: 'Оценка ущерба от ЧС (акты комиссий)',
    description:
      'Акты оценки ущерба комиссий по ЧС районов, 2013–2026: решение, повреждения, итоговая сумма. Источник — документы Word Комитета.',
    fields: DAMAGE_FIELDS,
    primaryKey: ['code'],
    timeField: 'event_date',
    territoryField: 'territory',
  })
  const damage = await insertMissing(
    pack,
    damageId,
    await readJson<Row[]>(dir, manifest.data.damage),
    ['code'],
  )
  say('оценка ущерба', { inserted: damage })

  const statsId = await ensureDataset(pack, 'history.dataset.stats', {
    name: 'Статистика ЧС «10 сола» (официальная)',
    description:
      'Официальная сводка Комитета 2013–2024: количество ЧС, погибшие и ущерб по годам и категориям. Строка TOTAL — итог года.',
    fields: STATS_FIELDS,
    primaryKey: ['year', 'category'],
  })
  const stats = await insertMissing(
    pack,
    statsId,
    await readJson<Row[]>(dir, manifest.data.stats),
    ['year', 'category'],
  )
  say('статистика', { inserted: stats })

  // Архив исходников: корень, подпапки по видам, файлы как в каталоге Комитета
  const root = await ensureFolder(pack, 'history.folder.root', manifest.archiveRoot, null)
  const folders = new Map<string, string>()
  let files = 0
  for (const item of manifest.archive) {
    let folderId = folders.get(item.folder)
    if (!folderId) {
      folderId = await ensureFolder(
        pack,
        `history.folder.${hashKey(item.folder)}`,
        item.folder,
        root,
      )
      folders.set(item.folder, folderId)
    }
    if ((await uploadFile(pack, dir, item.file, item.name, folderId)).created) files += 1
  }
  say('архив файлов', { uploaded: files })

  // Слои карты связи: каждый геофайл — датасет через импорт, затем слой и карта
  const gisFolder = await ensureFolder(pack, 'history.folder.gis', 'Слои карт (GeoPackage)', root)
  const entries: MapLayerEntry[] = []
  for (const layer of manifest.layers) {
    const datasetId = await importLayer(pack, dir, layer, gisFolder)
    const style = await fitStyle(datasetId, layer.style)
    const renderer = style.renderer as
      | { kind?: string; field?: string; categories?: unknown[] }
      | undefined
    if (
      renderer?.kind === 'categorized' &&
      renderer.field &&
      (renderer.categories ?? []).length === 0
    ) {
      style.renderer = { ...renderer, categories: await categoriesOf(datasetId, renderer.field) }
    }
    const layerId = await ensureLayer(
      pack,
      `history.layer.${layer.key}`,
      layer.name,
      datasetId,
      style,
    )
    entries.push({ layerId, visible: layer.visible, opacity: 1, group: null })
    say('слой', { layer: layer.name })
  }
  const communicationMap = await ensureMap(
    pack,
    'history.map.communication',
    manifest.map.name,
    entries,
    manifest.map.camera,
  )

  const historyLayer = await ensureLayer(
    pack,
    'history.layer.incidents',
    'История ЧС 1988–2026',
    incidentsId,
    incidentStyle(),
  )
  const borders = entries[0]
  const historyMap = await ensureMap(
    pack,
    'history.map.incidents',
    'История ЧС 1988–2026',
    [
      ...(borders ? [{ ...borders, visible: true }] : []),
      { layerId: historyLayer, visible: true, opacity: 1, group: null },
    ],
    manifest.map.camera,
  )
  const dashboardId = await ensureDashboard(pack, {
    stats: statsId,
    incidents: incidentsId,
    types: typesId,
    mapId: historyMap,
  })

  return {
    types,
    incidents,
    damage,
    stats,
    layers: entries.length,
    files,
    mapIds: [communicationMap, historyMap],
    dashboardId,
  }
}
