import {
  atLeast,
  type DatasetRow,
  type DatasetRowHistoryEntry,
  type DatasetRowInput,
  type DatasetRowPatch,
  type DatasetRowsQuery,
  type FilterNode,
  type QueryResult,
  type QueryResultField,
  QuerySpec,
  type StoredFieldType,
} from '@kchs/contracts'
import { fieldSchema } from '@kchs/fields'
import { eq, type SQL, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { type TerritoryIndex, territoryIndex } from '~/modules/gis/public.js'
import { actorId, type Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { datasets, objects } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { columnType, historyName, ident, qualified } from '../infra/physical.js'
import { DatasetAccess, type DatasetGrant } from './dataset-access.js'
import { DatasetService, type DatasetStorage, type StoredField } from './dataset-service.js'
import { QueryService } from './query-service.js'

/** Поля быстрого поиска таблицы. */
const SEARCH_TYPES = new Set<string>([
  'text',
  'long_text',
  'identifier',
  'select',
  'url',
  'email',
  'phone',
])
/** Для текста пустая строка — значение, для остальных типов — «пусто». */
const TEXT_TYPES = new Set<string>(['text', 'long_text', 'identifier'])
const NUMERIC = new Set<string>(['integer', 'number', 'decimal', 'money', 'percent'])
const FIELD_KEY = /^[a-z_][a-z0-9_]*$/
const HISTORY_OPS = { i: 'insert', u: 'update', d: 'delete' } as const

/** Ключ поля как псевдоним столбца: ключи — snake_case латиницей (FieldDef.key). */
function alias(key: string): SQL {
  if (!FIELD_KEY.test(key)) throw errors.internal(`Недопустимый ключ поля: ${key}`)
  return sql.raw(`"${key}"`)
}

/** Значение столбца в JSON: bigint и numeric — числа, даты — ISO 8601. */
function jsonOut(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (NUMERIC.has(type) && typeof value === 'string') return Number(value)
  if (value instanceof Date) {
    return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  }
  return value
}

/** Литерал массива Postgres из строк: кавычки и обратные косые экранируются. */
function textArrayLiteral(values: string[]): string {
  const items = values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
  return `{${items.join(',')}}`
}

/** Значение поля в SQL: параметром с приведением к типу столбца. */
export function valueSql(field: StoredField, value: unknown): SQL {
  if (value === null || value === undefined) return sql`NULL`
  const type = field.type as StoredFieldType
  if (type === 'geometry') {
    return sql`extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(${JSON.stringify(value)}), 4326)`
  }
  if (type === 'json') return sql`${JSON.stringify(value)}::jsonb`
  if (type === 'multi_select') return sql`${textArrayLiteral(value as string[])}::text[]`
  // Имя типа — из columnType (сгенерировано), значение — параметром
  return sql`${String(value)}::${sql.raw(columnType(type, field.format?.precision))}`
}

/** Столбцы строки под ключами полей; геометрия — GeoJSON. */
export function selectList(fields: StoredField[]): SQL {
  const columns = fields.map((field) =>
    field.type === 'geometry'
      ? sql`extensions.ST_AsGeoJSON(${sql.raw(ident(field.physical))})::json AS ${alias(field.key)}`
      : sql`${sql.raw(ident(field.physical))} AS ${alias(field.key)}`,
  )
  return columns.length > 0 ? sql`, ${sql.join(columns, sql`, `)}` : sql``
}

export function valuesOf(
  row: Record<string, unknown>,
  fields: StoredField[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.key, jsonOut(row[field.key], field.type)]))
}

interface Assignment {
  field: StoredField
  value: unknown
}

/**
 * Значение поля-территории: идентификатор из справочника, код или название
 * (без учёта регистра) → идентификатор; неизвестное или неоднозначное — ошибка поля.
 */
function territoryValue(
  territories: TerritoryIndex,
  value: string,
): { id: string } | { message: string } {
  if (territories.byId.has(value)) return { id: value }
  const found = territories.resolve(value)
  if (found === 'ambiguous') {
    return { message: `Название «${value}» неоднозначно — укажите код территории` }
  }
  return found ? { id: found } : { message: `Нет территории «${value}»` }
}

/**
 * Значения строки из запроса: поле должно существовать и быть видимым,
 * маскируемое и только для чтения не правится, значение — по типу поля.
 */
function prepare(
  storage: DatasetStorage,
  grant: DatasetGrant,
  values: Record<string, unknown>,
  insert: boolean,
  territories: TerritoryIndex | null,
): Assignment[] {
  const byKey = new Map(storage.fields.map((field) => [field.key, field]))
  const issues: Array<{ path: string; message: string; code?: string }> = []
  const out: Assignment[] = []
  for (const [key, raw] of Object.entries(values)) {
    const field = byKey.get(key)
    if (!field || grant.hidden.has(key)) {
      issues.push({ path: key, message: `Нет поля «${key}»` })
      continue
    }
    if (grant.masked.has(key) || field.readOnly) {
      throw errors.forbidden(`Поле «${key}» недоступно для правки`)
    }
    let normalized =
      typeof raw === 'string' && raw.trim() === '' && !TEXT_TYPES.has(field.type) ? null : raw
    if (field.type === 'territory' && typeof normalized === 'string' && territories) {
      const territory = territoryValue(territories, normalized.trim())
      if ('message' in territory) {
        issues.push({ path: key, message: territory.message })
        continue
      }
      normalized = territory.id
    }
    const parsed = fieldSchema(field, false).safeParse(normalized)
    if (!parsed.success) {
      issues.push({
        path: key,
        message: parsed.error.issues[0]?.message ?? 'Некорректное значение',
      })
      continue
    }
    const value = parsed.data ?? null
    if (value === null && field.required) {
      issues.push({ path: key, message: 'Обязательное поле', code: 'required' })
      continue
    }
    out.push({ field, value })
  }
  if (insert) {
    for (const field of storage.fields) {
      if (field.required && !grant.hidden.has(field.key) && !(field.key in values)) {
        issues.push({ path: field.key, message: 'Обязательное поле', code: 'required' })
      }
    }
  }
  if (issues.length > 0) {
    throw new AppError('validation_failed', issues[0]?.message ?? 'Проверьте значения', 400, {
      fieldErrors: issues,
    })
  }
  return out
}

/**
 * Правка строк (ADR-0051): уровень edit, правка включена в настройках, строки
 * не ограничены политикой — иначе правка могла бы задеть или создать строки,
 * которые пользователь не видит.
 */
async function writable(ctx: Ctx, datasetId: string) {
  const grant = await DatasetAccess.resolve(ctx, datasetId, 'edit')
  const storage = await DatasetService.storage(datasetId)
  if (!storage.settings.editable) {
    throw errors.forbidden('Правка строк отключена в настройках датасета')
  }
  if (grant.rows.kind !== 'all') {
    throw errors.forbidden('Строки датасета ограничены политикой — править их может управляющий')
  }
  // Справочник территорий — только датасетам с полями-территориями
  const territories = storage.fields.some((field) => field.type === 'territory')
    ? await territoryIndex()
    : null
  return { grant, storage, territories }
}

/** Может ли пользователь писать строки датасета напрямую и почему нет. */
export interface RowWriteAccess {
  /** Видит строки датасета (с его политиками). */
  view: boolean
  direct: boolean
  reason: 'no_data_access' | 'no_rights' | 'dataset_readonly' | 'row_policy' | null
}

/**
 * Происхождение записи: `_import_id` строки. Отправка формы сбора данных
 * (ADR-0103) помечает им свои строки — по нему видно, какая сдача их создала.
 */
export interface RowWriteOptions {
  importId?: string | undefined
}

/**
 * Транзакция вызывающего (правка объекта слоя вместе с событием модуля GIS,
 * применение принятой правки, ADR-0076) или своя.
 */
function inTransaction<T>(outer: Executor | undefined, work: (tx: Executor) => Promise<T>) {
  return outer ? work(outer) : db().transaction(work)
}

/** Видимые пользователю поля (скрытые политикой не читаются и не возвращаются). */
const visibleFields = (storage: DatasetStorage, grant: DatasetGrant) =>
  storage.fields.filter((field) => !grant.hidden.has(field.key) && !grant.masked.has(field.key))

/** Правка строк — версия `edit`, счётчик строк и событие `dataset.rows_changed`. */
async function rowsChanged(
  tx: Executor,
  ctx: Ctx,
  input: {
    datasetId: string
    op: 'insert' | 'update' | 'delete'
    ids: string[]
    delta: number
  },
): Promise<number> {
  const [row] = await tx
    .select({ rows: datasets.rowCount })
    .from(datasets)
    .where(eq(datasets.id, input.datasetId))
    .for('update')
  const count = input.ids.length
  const version = await DatasetService.bumpVersion(tx, ctx, {
    datasetId: input.datasetId,
    origin: 'edit',
    rowCount: Math.max(0, (row?.rows ?? 0) + input.delta),
    diff: {
      added: input.op === 'insert' ? count : 0,
      updated: input.op === 'update' ? count : 0,
      deleted: input.op === 'delete' ? count : 0,
    },
  })
  const [object] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, input.datasetId))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'dataset.rows_changed',
    object: {
      id: input.datasetId,
      type: 'dataset',
      spaceId: object?.spaceId ?? null,
      title: object?.title,
    },
    payload: { op: input.op, ids: input.ids.slice(0, 1000), count },
  })
  return version
}

/**
 * Записи истории строк с номером версии датасета, в которой сделана правка:
 * по нему откат версии находит, что вернуть (ADR-0062).
 */
export async function writeHistory(
  tx: Executor,
  storage: Pick<DatasetStorage, 'id' | 'settings'>,
  entries: Array<{ rowId: string; ver: number; op: 'i' | 'u' | 'd'; data: unknown }>,
  userId: string | null,
  datasetVersion: number,
): Promise<void> {
  if (!storage.settings.trackHistory || entries.length === 0) return
  const history = sql.raw(qualified(historyName(storage.id)))
  await tx.execute(
    sql`INSERT INTO ${history} (row_id, ver, op, data, changed_by, dataset_version)
        VALUES ${sql.join(
          entries.map(
            (entry) =>
              sql`(${entry.rowId}::bigint, ${entry.ver}, ${entry.op}, ${JSON.stringify(entry.data)}::jsonb, ${userId}::uuid, ${datasetVersion})`,
          ),
          sql`, `,
        )}`,
  )
}

function toDatasetRow(fields: QueryResultField[], row: unknown[]): DatasetRow {
  const values: Record<string, unknown> = {}
  let id = ''
  let ver = 1
  fields.forEach((field, index) => {
    if (field.name === '_id') id = String(row[index])
    else if (field.name === '_ver') ver = Number(row[index])
    else values[field.name] = row[index]
  })
  return { _id: id, _ver: ver, values }
}

/**
 * Строки датасета (P1-E01 S03, ADR-0051): чтение — через компилятор запросов с
 * политиками пользователя, правка — с оптимистичной блокировкой по `_ver`,
 * историей в `ds.h_*`, версией и событием в той же транзакции.
 */
/**
 * Фильтр таблицы: условия пользователя и быстрый поиск `contains` по видимым
 * текстовым полям через OR (маскированные ищутся по маске). Общий для таблицы
 * и экспорта «как в таблице».
 */
export function tableFilter(
  storage: DatasetStorage,
  grant: DatasetGrant,
  input: { where?: FilterNode | undefined; search?: string | undefined },
): FilterNode | null {
  const conditions: FilterNode[] = input.where ? [input.where] : []
  const search = input.search?.trim()
  if (search) {
    const fields = storage.fields.filter(
      (field) => SEARCH_TYPES.has(field.type) && !grant.hidden.has(field.key),
    )
    if (fields.length > 0) {
      conditions.push({
        or: fields.map((field) => ({ field: field.key, op: 'contains' as const, value: search })),
      })
    }
  }
  if (conditions.length === 0) return null
  return conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions }
}

export const RowService = {
  /**
   * Страница строк таблицы: фильтр, поиск, сортировка (с `_id` для стабильных
   * страниц). Охват карты — пространственное окно компилятора (ADR-0064, ADR-0073):
   * рамка рядом с политикой строк, по индексу GIST; скрытое поле геометрии — 400.
   */
  async query(ctx: Ctx, datasetId: string, input: DatasetRowsQuery): Promise<QueryResult> {
    const grant = await DatasetAccess.resolve(ctx, datasetId)
    const storage = await DatasetService.storage(datasetId)
    const where = tableFilter(storage, grant, input)
    const spec = QuerySpec.parse({
      version: 1,
      source: { kind: 'dataset', id: datasetId },
      steps: [
        ...(where ? [{ type: 'filter', where }] : []),
        {
          type: 'sort',
          by: [...input.sort.filter((item) => item.field !== '_id'), { field: '_id', dir: 'asc' }],
        },
        { type: 'limit', limit: input.limit, offset: input.offset },
      ],
    })
    return QueryService.run(ctx, spec, {
      rowMeta: true,
      count: input.count,
      maxRows: null,
      ...(input.bbox
        ? { spatialWindow: { datasetId, field: input.bbox.field, bbox: input.bbox.bbox } }
        : {}),
    })
  },

  /** Строка по `_id` — с политиками пользователя (как в таблице). */
  async get(ctx: Ctx, datasetId: string, rowId: string): Promise<DatasetRow> {
    const spec = QuerySpec.parse({
      version: 1,
      source: { kind: 'dataset', id: datasetId },
      steps: [{ type: 'filter', where: { field: '_id', op: 'eq', value: Number(rowId) } }],
    })
    const result = await QueryService.run(ctx, spec, { rowMeta: true, maxRows: 1 })
    const [row] = result.rows
    if (!row) throw errors.notFound('Строка')
    return toDatasetRow(result.fields, row)
  },

  /**
   * Правка напрямую (ADR-0051, ADR-0076): право edit, правка включена в
   * настройках, строки не ограничены политикой — как у записи строк.
   */
  async writeAccess(ctx: Ctx, datasetId: string): Promise<RowWriteAccess> {
    const view = await authorize(ctx, 'view', datasetId, { soft: true })
    if (!view.allowed) return { view: false, direct: false, reason: 'no_data_access' }
    const [edit, grant, storage] = await Promise.all([
      authorize(ctx, 'edit', datasetId, { soft: true }),
      DatasetAccess.resolve(ctx, datasetId),
      DatasetService.storage(datasetId),
    ])
    const reason: RowWriteAccess['reason'] =
      !edit.allowed || !atLeast(grant.level, 'edit')
        ? 'no_rights'
        : !storage.settings.editable
          ? 'dataset_readonly'
          : grant.rows.kind !== 'all'
            ? 'row_policy'
            : null
    return { view: true, direct: reason === null, reason }
  },

  /**
   * Значения строки с правами пользователя — те же проверки, что при записи, но
   * без записи (предложение правки на проверку, ADR-0076): поле видимо и не
   * маскировано, значение по типу, обязательные — при создании. Результат —
   * значения в JSON-виде (территория — идентификатором справочника).
   */
  async validate(
    ctx: Ctx,
    datasetId: string,
    values: Record<string, unknown>,
    insert: boolean,
  ): Promise<Record<string, unknown>> {
    const grant = await DatasetAccess.resolve(ctx, datasetId)
    const storage = await DatasetService.storage(datasetId)
    if (!storage.settings.editable) {
      throw errors.forbidden('Правка строк отключена в настройках датасета')
    }
    const territories = storage.fields.some((field) => field.type === 'territory')
      ? await territoryIndex()
      : null
    return Object.fromEntries(
      prepare(storage, grant, values, insert, territories).map((item) => [
        item.field.key,
        jsonOut(item.value, item.field.type),
      ]),
    )
  },

  async insert(
    ctx: Ctx,
    datasetId: string,
    rows: DatasetRowInput[],
    outer?: Executor,
    options: RowWriteOptions = {},
  ): Promise<DatasetRow[]> {
    const { grant, storage, territories } = await writable(ctx, datasetId)
    const prepared = rows.map((row, index) => {
      try {
        return prepare(storage, grant, row.values, true, territories)
      } catch (error) {
        // Номер строки пакета: вставка из буфера показывает, какую строку исправить
        if (error instanceof AppError && error.code === 'validation_failed' && rows.length > 1) {
          throw new AppError('validation_failed', `Строка ${index + 1}: ${error.message}`, 400, {
            ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
            data: { row: index },
          })
        }
        throw error
      }
    })
    const assigned = new Set(prepared.flatMap((row) => row.map((item) => item.field.key)))
    const fields = storage.fields.filter((field) => assigned.has(field.key))
    const userId = actorId(ctx)
    const table = sql.raw(qualified(storage.table))
    const columns = fields.map((field) => sql.raw(ident(field.physical)))

    return inTransaction(outer, async (tx) => {
      let inserted: Array<{ _id: string; _ver: number }>
      try {
        inserted = await tx.execute<{ _id: string; _ver: number }>(
          sql`INSERT INTO ${table} (${sql.join(
            [
              ...columns,
              sql`_created_by`,
              sql`_updated_by`,
              ...(options.importId ? [sql`_import_id`] : []),
            ],
            sql`, `,
          )})
              VALUES ${sql.join(
                prepared.map((row) => {
                  const byKey = new Map(row.map((item) => [item.field.key, item.value]))
                  return sql`(${sql.join(
                    [
                      ...fields.map((field) => valueSql(field, byKey.get(field.key) ?? null)),
                      sql`${userId}::uuid`,
                      sql`${userId}::uuid`,
                      ...(options.importId ? [sql`${options.importId}::uuid`] : []),
                    ],
                    sql`, `,
                  )})`
                }),
                sql`, `,
              )}
              RETURNING _id::text AS _id, _ver`,
        )
      } catch (error) {
        if (pgErrorCode(error) === UNIQUE_VIOLATION) {
          throw errors.conflict('Строка с таким ключом уже есть')
        }
        throw error
      }
      const result = inserted.map((row, index) => {
        const values = Object.fromEntries(
          (prepared[index] ?? []).map((item) => [
            item.field.key,
            jsonOut(item.value, item.field.type),
          ]),
        )
        return { _id: row._id, _ver: Number(row._ver), values }
      })
      const version = await rowsChanged(tx, ctx, {
        datasetId,
        op: 'insert',
        ids: result.map((row) => row._id),
        delta: result.length,
      })
      await writeHistory(
        tx,
        storage,
        result.map((row) => ({
          rowId: row._id,
          ver: row._ver,
          op: 'i',
          data: { values: row.values },
        })),
        userId,
        version,
      )
      return result
    })
  },

  /**
   * Правка строки с версией, которую видел пользователь: строку изменили —
   * 409 с текущим состоянием и полями, изменёнными с тех пор.
   */
  async update(
    ctx: Ctx,
    datasetId: string,
    rowId: string,
    patch: DatasetRowPatch,
    outer?: Executor,
    options: RowWriteOptions = {},
  ): Promise<DatasetRow> {
    const { grant, storage, territories } = await writable(ctx, datasetId)
    const assignments = prepare(storage, grant, patch.values, false, territories)
    if (assignments.length === 0) throw errors.validation('Нет значений для правки')
    const fields = visibleFields(storage, grant)
    const table = sql.raw(qualified(storage.table))
    const userId = actorId(ctx)

    return inTransaction(outer, async (tx) => {
      const [current] = await tx.execute<Record<string, unknown>>(
        sql`SELECT _id::text AS _id, _ver ${selectList(fields)} FROM ${table}
             WHERE _id = ${rowId}::bigint AND _deleted_at IS NULL FOR UPDATE`,
      )
      if (!current) throw errors.notFound('Строка')
      const currentVer = Number(current._ver)
      const currentValues = valuesOf(current, fields)
      if (currentVer !== patch.ver) {
        const changedFields = await RowService.changedSince(
          tx,
          storage,
          rowId,
          patch.ver,
          currentValues,
          patch.values,
        )
        throw new AppError('conflict', 'Строку уже изменили — проверьте её текущие значения', 409, {
          data: {
            current: { _id: rowId, _ver: currentVer, values: currentValues },
            changedFields,
          },
        })
      }
      const changed = assignments.filter(
        (item) =>
          JSON.stringify(currentValues[item.field.key] ?? null) !==
          JSON.stringify(jsonOut(item.value, item.field.type)),
      )
      if (changed.length === 0) return { _id: rowId, _ver: currentVer, values: currentValues }

      let updated: { _ver: number } | undefined
      try {
        ;[updated] = await tx.execute<{ _ver: number }>(
          sql`UPDATE ${table}
                 SET ${sql.join(
                   changed.map(
                     (item) =>
                       sql`${sql.raw(ident(item.field.physical))} = ${valueSql(item.field, item.value)}`,
                   ),
                   sql`, `,
                 )}, _ver = _ver + 1, _updated_at = now(), _updated_by = ${userId}::uuid${
                   options.importId ? sql`, _import_id = ${options.importId}::uuid` : sql``
                 }
               WHERE _id = ${rowId}::bigint
           RETURNING _ver`,
        )
      } catch (error) {
        if (pgErrorCode(error) === UNIQUE_VIOLATION) {
          throw errors.conflict('Строка с таким ключом уже есть')
        }
        throw error
      }
      const ver = Number(updated?._ver ?? currentVer + 1)
      const next = Object.fromEntries(
        changed.map((item) => [item.field.key, jsonOut(item.value, item.field.type)]),
      )
      const previous = Object.fromEntries(
        changed.map((item) => [item.field.key, currentValues[item.field.key] ?? null]),
      )
      const version = await rowsChanged(tx, ctx, {
        datasetId,
        op: 'update',
        ids: [rowId],
        delta: 0,
      })
      await writeHistory(
        tx,
        storage,
        [{ rowId, ver, op: 'u', data: { values: next, previous } }],
        userId,
        version,
      )
      return { _id: rowId, _ver: ver, values: { ...currentValues, ...next } }
    })
  },

  /**
   * Поля, изменённые после версии пользователя: по истории строки, а без
   * истории — те из его правки, что расходятся с текущими значениями.
   */
  async changedSince(
    tx: Executor,
    storage: DatasetStorage,
    rowId: string,
    ver: number,
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<string[]> {
    if (storage.settings.trackHistory) {
      const entries = await tx.execute<{ data: { values?: Record<string, unknown> } | null }>(
        sql`SELECT data FROM ${sql.raw(qualified(historyName(storage.id)))}
             WHERE row_id = ${rowId}::bigint AND ver > ${ver}`,
      )
      const keys = new Set<string>()
      for (const entry of entries)
        for (const key of Object.keys(entry.data?.values ?? {})) keys.add(key)
      return [...keys].filter((key) => key in current)
    }
    return Object.keys(patch).filter(
      (key) => key in current && JSON.stringify(current[key]) !== JSON.stringify(patch[key]),
    )
  },

  /**
   * Удаление: при истории — мягкое (строка остаётся для версий и истории), иначе —
   * окончательное. С `ver` (одна строка, объект на карте) — только той версии,
   * что видел пользователь: строку изменили — 409 с текущими значениями.
   */
  async remove(
    ctx: Ctx,
    datasetId: string,
    ids: string[],
    outer?: Executor,
    options: { ver?: number } = {},
  ): Promise<number> {
    const { grant, storage } = await writable(ctx, datasetId)
    const unique = [...new Set(ids)]
    // Идентификаторы проверены контрактом (цифры) — литерал массива безопасен
    const idList = `{${unique.join(',')}}`
    const table = sql.raw(qualified(storage.table))
    const userId = actorId(ctx)
    const fields = visibleFields(storage, grant)

    return inTransaction(outer, async (tx) => {
      if (options.ver !== undefined) {
        const [rowId] = unique
        if (!rowId || unique.length !== 1) throw errors.validation('Версия — для одной строки')
        const [current] = await tx.execute<Record<string, unknown>>(
          sql`SELECT _id::text AS _id, _ver ${selectList(fields)} FROM ${table}
               WHERE _id = ${rowId}::bigint AND _deleted_at IS NULL FOR UPDATE`,
        )
        if (!current) throw errors.notFound('Строка')
        const currentVer = Number(current._ver)
        if (currentVer !== options.ver) {
          const currentValues = valuesOf(current, fields)
          const changedFields = await RowService.changedSince(
            tx,
            storage,
            rowId,
            options.ver,
            currentValues,
            {},
          )
          throw new AppError(
            'conflict',
            'Строку уже изменили — проверьте её текущие значения',
            409,
            {
              data: {
                current: { _id: rowId, _ver: currentVer, values: currentValues },
                changedFields,
              },
            },
          )
        }
      }
      let removed: Array<Record<string, unknown>>
      if (storage.settings.trackHistory) {
        removed = await tx.execute<Record<string, unknown>>(
          sql`UPDATE ${table}
                 SET _deleted_at = now(), _updated_at = now(), _updated_by = ${userId}::uuid, _ver = _ver + 1
               WHERE _id = ANY(${idList}::bigint[]) AND _deleted_at IS NULL
           RETURNING _id::text AS _id, _ver ${selectList(fields)}`,
        )
      } else {
        removed = await tx.execute<Record<string, unknown>>(
          sql`DELETE FROM ${table} WHERE _id = ANY(${idList}::bigint[]) RETURNING _id::text AS _id`,
        )
      }
      if (removed.length > 0) {
        const version = await rowsChanged(tx, ctx, {
          datasetId,
          op: 'delete',
          ids: removed.map((row) => String(row._id)),
          delta: -removed.length,
        })
        await writeHistory(
          tx,
          storage,
          removed.map((row) => ({
            rowId: String(row._id),
            ver: Number(row._ver),
            op: 'd',
            data: { values: valuesOf(row, fields) },
          })),
          userId,
          version,
        )
      }
      return removed.length
    })
  },

  /**
   * История строки из `ds.h_*`. Прежние значения политики столбцов не
   * проходят, поэтому история — тем, кто видит все строки и все столбцы.
   */
  async history(ctx: Ctx, datasetId: string, rowId: string): Promise<DatasetRowHistoryEntry[]> {
    const grant = await DatasetAccess.resolve(ctx, datasetId)
    if (
      !grant.unrestricted &&
      (grant.rows.kind !== 'all' || grant.hidden.size > 0 || grant.masked.size > 0)
    ) {
      throw errors.forbidden('История строки недоступна при ограничениях политики')
    }
    const storage = await DatasetService.storage(datasetId)
    if (!storage.settings.trackHistory) return []
    const rows = await db().execute<{
      id: string
      ver: number
      op: 'i' | 'u' | 'd'
      data: { values?: Record<string, unknown>; previous?: Record<string, unknown> } | null
      changed_by: string | null
      changed_at: Date | string
    }>(
      // Порядок — по числовому id: имя `id` в ORDER BY означало бы текстовый псевдоним
      sql`SELECT h.id::text AS id, h.ver, h.op, h.data, h.changed_by, h.changed_at
            FROM ${sql.raw(qualified(historyName(datasetId)))} AS h
           WHERE h.row_id = ${rowId}::bigint ORDER BY h.id DESC LIMIT 200`,
    )
    const refs = await directory().refs([
      ...new Set(rows.map((row) => row.changed_by).filter((id): id is string => id !== null)),
    ])
    return rows.map((row) => ({
      id: row.id,
      op: HISTORY_OPS[row.op],
      ver: Number(row.ver),
      values: row.data?.values ?? {},
      previous: row.data?.previous ?? null,
      changedBy: row.changed_by ? (refs.get(row.changed_by) ?? null) : null,
      changedAt: new Date(row.changed_at).toISOString(),
    }))
  },
}
