import type {
  DatasetCreateInput,
  DatasetField,
  DatasetFieldInput,
  DatasetKind,
  DatasetRecord,
  DatasetVersion,
  FieldSemantic,
  StoredFieldType,
} from '@kchs/contracts'
import { DatasetSettings, FieldDef } from '@kchs/contracts'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import { datasetFields, datasets, datasetVersions, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { columnName, Physical, type PhysicalColumn, tableName } from '../infra/physical.js'

/** Поле с физическим столбцом — для компилятора запросов, импорта и правки строк. */
export interface StoredField extends DatasetField {
  physical: string
}

/** Метаданные хранения датасета — только внутри модуля и для компилятора. */
export interface DatasetStorage {
  id: string
  table: string
  fields: StoredField[]
  primaryKey: string[]
  settings: DatasetSettings
  currentVersion: number
  spaceId: string
}

/** Столбцы определения поля, хранящиеся отдельными колонками таблицы полей. */
const PLAIN_KEYS = new Set([
  'key',
  'label',
  'type',
  'semantic',
  'format',
  'unit',
  'nullable',
  'required',
  'unique',
  'indexed',
  'sensitive',
  'lookup',
  'expression',
  'description',
  'order',
])

type FieldRow = typeof datasetFields.$inferSelect

function toField(row: FieldRow): StoredField {
  const definition = FieldDef.parse({
    ...row.definition,
    key: row.key,
    label: row.label,
    type: row.type,
    semantic: row.semantic,
    ...(row.format ? { format: row.format } : {}),
    ...(row.unit ? { unit: row.unit } : {}),
    nullable: row.nullable,
    required: row.required,
    unique: row.unique,
    indexed: row.indexed,
    sensitive: row.sensitive,
    ...(row.lookup ? { lookup: row.lookup } : {}),
    ...(row.formula ? { expression: row.formula } : {}),
    ...(row.description ? { description: row.description } : {}),
    order: row.order,
  })
  return { ...definition, id: row.id, physical: row.physicalColumn ?? '' }
}

/** Строка таблицы полей для нового поля датасета. */
export function fieldValues(
  datasetId: string,
  field: DatasetFieldInput,
  physical: string,
  order: number,
) {
  const rest = Object.fromEntries(Object.entries(field).filter(([key]) => !PLAIN_KEYS.has(key)))
  return {
    id: newId(),
    datasetId,
    key: field.key,
    label: field.label,
    type: field.type,
    semantic: field.semantic,
    format: field.format ?? null,
    unit: field.unit ?? null,
    nullable: field.nullable,
    required: field.required,
    unique: field.unique,
    indexed: field.indexed,
    sensitive: field.sensitive,
    lookup: field.lookup ?? null,
    formula: field.expression ?? null,
    description: field.description ?? null,
    order,
    definition: rest,
    physicalColumn: physical,
  }
}

/**
 * Датасеты (06-analytics-engine.md §3). Создание — одна транзакция: объект
 * реестра, метаданные, физическая таблица `ds.t_*`, первая версия и событие.
 */
export const DatasetService = {
  async create(tx: Executor, ctx: Ctx, input: DatasetCreateInput): Promise<string> {
    const object = await ObjectService.create(tx, ctx, {
      type: 'dataset',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      subtitle: input.description ?? null,
      meta: { rows: 0, fields: input.fields.length, kind: input.kind },
    })
    const id = object.id
    const settings: DatasetSettings = {
      editable: input.settings?.editable ?? true,
      trackHistory: input.settings?.trackHistory ?? true,
    }

    // Физическое имя столбца — по счётчику: переименование ключа поля его не трогает
    const columns: PhysicalColumn[] = input.fields.map((field, index) => ({
      name: columnName(index + 1),
      type: field.type as StoredFieldType,
      precision: field.format?.precision,
      indexed: field.indexed,
    }))
    const physicalOf = new Map(
      input.fields.map((field, index) => [field.key, columnName(index + 1)]),
    )

    await tx.insert(datasets).values({
      id,
      kind: input.kind,
      primaryKey: input.primaryKey,
      timeField: input.timeField ?? null,
      territoryField: input.territoryField ?? null,
      settings,
      description: input.description ?? null,
      physicalTable: tableName(id),
      nextColumn: input.fields.length + 1,
      currentVersion: 1,
    })
    await tx
      .insert(datasetFields)
      .values(
        input.fields.map((field, index) =>
          fieldValues(id, field, columnName(index + 1), field.order || index),
        ),
      )
    await Physical.createTable(tx, id, columns, {
      trackHistory: settings.trackHistory,
      keyColumns: input.primaryKey.map((key) => physicalOf.get(key) as string),
    })
    await tx.insert(datasetVersions).values({
      id: newId(),
      datasetId: id,
      number: 1,
      origin: 'create',
      rowCount: 0,
      diff: { added: 0, updated: 0, deleted: 0 },
      createdBy: actorId(ctx),
    })
    await publishEvent(tx, ctx, {
      type: 'dataset.created',
      object: { id, type: 'dataset', spaceId: object.spaceId, title: input.name },
      payload: { name: input.name, fields: input.fields.length },
    })
    return id
  },

  /** Хранение датасета: таблица и поля с физическими столбцами. */
  async storage(id: string, database: Executor = db()): Promise<DatasetStorage> {
    const [row] = await database
      .select({
        id: datasets.id,
        table: datasets.physicalTable,
        primaryKey: datasets.primaryKey,
        settings: datasets.settings,
        currentVersion: datasets.currentVersion,
        spaceId: objects.spaceId,
      })
      .from(datasets)
      .innerJoin(objects, eq(objects.id, datasets.id))
      .where(eq(datasets.id, id))
      .limit(1)
    if (!row?.spaceId) throw errors.notFound('Датасет')
    const fields = await database
      .select()
      .from(datasetFields)
      .where(eq(datasetFields.datasetId, id))
      .orderBy(asc(datasetFields.order), asc(datasetFields.createdAt))
    return {
      id: row.id,
      table: row.table,
      fields: fields.map(toField),
      primaryKey: row.primaryKey,
      settings: DatasetSettings.parse(row.settings ?? {}),
      currentVersion: row.currentVersion,
      spaceId: row.spaceId,
    }
  },

  async get(id: string, database: Database = db()): Promise<DatasetRecord> {
    const [row] = await database
      .select({ dataset: datasets, object: objects })
      .from(datasets)
      .innerJoin(objects, eq(objects.id, datasets.id))
      .where(eq(datasets.id, id))
      .limit(1)
    if (!row?.object.spaceId) throw errors.notFound('Датасет')
    const storage = await DatasetService.storage(id, database)
    return {
      id,
      name: row.object.title,
      description: row.dataset.description,
      kind: row.dataset.kind as DatasetKind,
      spaceId: row.object.spaceId,
      parentId: row.object.parentId,
      fields: storage.fields.map(({ physical: _physical, ...field }) => field),
      primaryKey: row.dataset.primaryKey,
      timeField: row.dataset.timeField,
      territoryField: row.dataset.territoryField,
      rowCount: row.dataset.rowCount,
      currentVersion: row.dataset.currentVersion,
      schemaVersion: row.dataset.schemaVersion,
      lastImportAt: row.dataset.lastImportAt,
      settings: storage.settings,
      createdAt: row.object.createdAt,
      updatedAt: row.object.updatedAt,
    }
  },

  async versions(id: string, database: Database = db()): Promise<DatasetVersion[]> {
    const rows = await database
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.datasetId, id))
      .orderBy(desc(datasetVersions.number))
      .limit(200)
    const refs = await directory().refs(
      [...new Set(rows.map((row) => row.createdBy).filter((value) => value !== null))],
      database,
    )
    return rows.map((row) => ({
      number: row.number,
      origin: row.origin as DatasetVersion['origin'],
      createdAt: row.createdAt,
      createdBy: row.createdBy ? (refs.get(row.createdBy) ?? null) : null,
      rowCount: row.rowCount,
      diff: {
        added: row.diff.added ?? 0,
        updated: row.diff.updated ?? 0,
        deleted: row.diff.deleted ?? 0,
      },
      importId: row.importId,
    }))
  },

  /** Новая версия после изменения данных — в транзакции изменения. */
  async bumpVersion(
    tx: Executor,
    ctx: Ctx,
    input: {
      datasetId: string
      origin: DatasetVersion['origin']
      rowCount: number
      diff: { added: number; updated: number; deleted: number }
      importId?: string | null
    },
  ): Promise<number> {
    const [row] = await tx
      .update(datasets)
      .set({
        currentVersion: sql`${datasets.currentVersion} + 1`,
        rowCount: input.rowCount,
        updatedAt: sql`now()`,
        ...(input.origin === 'import' ? { lastImportAt: sql`now()` } : {}),
      })
      .where(eq(datasets.id, input.datasetId))
      .returning({ version: datasets.currentVersion })
    if (!row) throw errors.notFound('Датасет')
    await tx.insert(datasetVersions).values({
      id: newId(),
      datasetId: input.datasetId,
      number: row.version,
      origin: input.origin,
      rowCount: input.rowCount,
      diff: input.diff,
      importId: input.importId ?? null,
      createdBy: actorId(ctx),
    })
    await tx
      .update(objects)
      .set({
        meta: sql`${objects.meta} || ${JSON.stringify({ rows: input.rowCount })}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(objects.id, input.datasetId))
    return row.version
  },
}

/** Семантика по умолчанию для типа поля — если импорт или форма её не задали. */
export function defaultSemantic(type: StoredFieldType): FieldSemantic {
  switch (type) {
    case 'integer':
    case 'number':
    case 'decimal':
    case 'money':
    case 'percent':
      return 'measure'
    case 'date':
    case 'datetime':
      return 'time'
    case 'geometry':
      return 'geometry'
    case 'identifier':
      return 'identifier'
    case 'territory':
      return 'territory'
    case 'long_text':
      return 'text'
    default:
      return 'dimension'
  }
}
