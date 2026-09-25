import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { StoredFieldType } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import type { Executor } from '~/shared/db/client.js'
import { rawSql } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'

/**
 * Физическое хранение датасетов (05-data-model.md §«Физические таблицы датасетов»).
 * Единственное место DDL схемы `ds`: таблицы строк `t_*`, истории `h_*`,
 * staging `s_*` импорта. Имена генерируются здесь из идентификаторов и
 * счётчиков — пользовательский ввод в текст SQL не попадает (правило 5).
 *
 * Права: роль пользовательских запросов `kchs_query` читает только таблицы
 * строк `t_*`. Права по умолчанию схемы `ds` открывают ей любую новую таблицу
 * роли приложения, поэтому таблице строк чтение выдаётся явно (не полагаясь на
 * роль-создателя), а у истории, staging и таблицы замены — явно отзывается:
 * в истории старые значения, к которым политики столбцов не применяются (ADR-0048).
 */

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

/** Экранирование имени: только сгенерированные имена, иначе — ошибка программиста. */
export function ident(name: string): string {
  if (!IDENT.test(name)) throw errors.internal(`Недопустимое имя в DDL: ${name}`)
  return `"${name}"`
}

const compact = (id: string) => id.replaceAll('-', '').toLowerCase()

export const tableName = (datasetId: string) => `t_${compact(datasetId)}`
export const historyName = (datasetId: string) => `h_${compact(datasetId)}`
export const stagingName = (importId: string) => `s_${compact(importId)}`
export const columnName = (n: number) => `c_${n}`

/** `ds."t_…"` — полное имя таблицы в схеме датасетов. */
export const qualified = (table: string) => `ds.${ident(table)}`

/** Тип поля → тип столбца Postgres (05-data-model.md «Типы полей → столбцы»). */
export function columnType(type: StoredFieldType, precision?: number): string {
  switch (type) {
    case 'text':
    case 'long_text':
    case 'select':
    case 'identifier':
    case 'url':
    case 'email':
    case 'phone':
      return 'text'
    case 'integer':
      return 'bigint'
    case 'number':
    case 'percent':
      return 'double precision'
    case 'decimal':
      return precision !== undefined ? `numeric(38, ${Math.min(precision, 12)})` : 'numeric'
    case 'money':
      return 'numeric(18, 2)'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'datetime':
      return 'timestamptz'
    case 'time':
      return 'time'
    case 'duration':
      return 'interval'
    case 'multi_select':
      return 'text[]'
    case 'user':
    case 'unit':
    case 'territory':
    case 'object_ref':
    case 'file':
      return 'uuid'
    case 'json':
      return 'jsonb'
    case 'geometry':
      return 'geometry(Geometry, 4326)'
  }
}

export interface PhysicalColumn {
  name: string
  type: StoredFieldType
  precision?: number
  indexed?: boolean
}

/**
 * Уникальный индекс ключа строки — только по живым строкам (ADR-0160): мягко
 * удалённая строка ключ не держит, новая строка с тем же ключом допустима.
 */
const keyIndexStatement = (table: string, keyColumns: string[]) =>
  `CREATE UNIQUE INDEX ON ${qualified(table)} (${keyColumns.map(ident).join(', ')}) WHERE _deleted_at IS NULL`

/** Таблица строк датасета (не staging `s_*` и не таблица замены `*_n`). */
const ROWS_TABLE = /^t_[0-9a-f]{32}$/

const columnDefs = (columns: PhysicalColumn[]) =>
  columns.map((column) => `${ident(column.name)} ${columnType(column.type, column.precision)}`)

/** Индекс по столбцу: GIST для геометрии, trigram для текста, B-tree для остального. */
function indexStatement(table: string, column: PhysicalColumn): string | null {
  if (column.type === 'geometry') {
    return `CREATE INDEX ON ${qualified(table)} USING gist (${ident(column.name)})`
  }
  if (!column.indexed) return null
  if (column.type === 'text' || column.type === 'long_text') {
    return `CREATE INDEX ON ${qualified(table)} USING gin (${ident(column.name)} extensions.gin_trgm_ops)`
  }
  return `CREATE INDEX ON ${qualified(table)} (${ident(column.name)})`
}

/** Типы, хранимые текстом: к ним приводится любое значение. */
const TEXT_STORED = new Set<StoredFieldType>([
  'text',
  'long_text',
  'select',
  'identifier',
  'url',
  'email',
  'phone',
])

/** Приведение столбца: исходное значение текстом и выражение с новым типом. */
export interface CastExpression {
  /** Непустое исходное значение текстом (пустые строки — NULL). */
  source: string
  /** Значение нового типа; NULL, если исходное не приводится. */
  expression: string
}

/**
 * Приведение столбца к новому типу (ADR-0047) через текст и `pg_input_is_valid`:
 * значение, которое не приводится, становится NULL — пробный прогон считает
 * такие значения, применение допускает их потерю только с согласия.
 */
export function castExpression(
  column: string,
  from: StoredFieldType,
  to: StoredFieldType,
  precision?: number,
): CastExpression {
  if (from === 'geometry' || to === 'geometry') {
    throw errors.validation('Геометрию нельзя привести к другому типу, а другой тип — к геометрии')
  }
  const c = ident(column)
  const text = from === 'multi_select' ? `array_to_string(${c}, ', ')` : `${c}::text`
  const source = `nullif(btrim(${text}), '')`
  if (TEXT_STORED.has(to)) return { source, expression: text }
  if (to === 'multi_select') {
    return {
      source,
      expression: `array_remove(regexp_split_to_array(${source}, '\\s*[,;]\\s*'), '')`,
    }
  }
  // Имя типа — из columnType (сгенерировано), точность — число из контракта
  const target = columnType(to, precision)
  return {
    source,
    expression: `CASE WHEN pg_input_is_valid(${source}, '${target}') THEN ${source}::${target} END`,
  }
}

/** Столбец сравнения импорта с таблицей: физическое имя, ключ поля и тип. */
export interface DiffColumn {
  physical: string
  key: string
  type: StoredFieldType
}

/** Пример изменения: значения ключа, номер строки файла, поля «было → стало». */
export interface ImportDiffSample {
  key: (string | null)[]
  row: number | null
  changes: Array<{ field: string; before: string | null; after: string | null }>
  restored?: boolean
}

export interface ImportDiffCounts {
  added: number
  changed: number
  unchanged: number
  deleted: number
  samples: { added: ImportDiffSample[]; changed: ImportDiffSample[]; deleted: ImportDiffSample[] }
}

/** Длина значения в примере изменения. */
const DIFF_TEXT_CHARS = 200
/** Полей в примере добавляемой или удаляемой строки. */
const DIFF_SAMPLE_FIELDS = 6

interface DiffSampleRow {
  row: string | null
  keys: (string | null)[]
  before: (string | null)[] | null
  after: (string | null)[] | null
  distinct: boolean[] | null
  restored: boolean
}

/** Значение столбца текстом для примера: геометрия — WKT, остальное — как в Postgres. */
function diffText(alias: string, column: DiffColumn): string {
  const value = `${alias}.${ident(column.physical)}`
  return column.type === 'geometry'
    ? `left(extensions.ST_AsText(${value}), ${DIFF_TEXT_CHARS})`
    : `left(${value}::text, ${DIFF_TEXT_CHARS})`
}

function diffSample(
  row: DiffSampleRow,
  fields: string[],
  kind: 'added' | 'changed' | 'deleted',
): ImportDiffSample {
  const before = row.before ?? []
  const after = row.after ?? []
  let changes: ImportDiffSample['changes']
  if (kind === 'changed') {
    const distinct = row.distinct ?? []
    changes = fields.flatMap((field, index) =>
      distinct[index]
        ? [{ field, before: before[index] ?? null, after: after[index] ?? null }]
        : [],
    )
  } else {
    const values = kind === 'added' ? after : before
    changes = fields
      .flatMap((field, index) => {
        const value = values[index] ?? null
        if (value === null) return []
        return [
          kind === 'added'
            ? { field, before: null, after: value }
            : { field, before: value, after: null },
        ]
      })
      .slice(0, DIFF_SAMPLE_FIELDS)
  }
  return {
    key: row.keys,
    row: row.row === null ? null : Number(row.row),
    changes,
    ...(row.restored ? { restored: true } : {}),
  }
}

/** Тип столбца записи `jsonb_to_recordset` для значения результата запроса. */
function recordType(column: PhysicalColumn): string {
  if (column.type === 'geometry') return 'jsonb'
  if (column.type === 'duration') return 'double precision'
  return columnType(column.type, column.precision)
}

/** Значение столбца таблицы из записи: GeoJSON → геометрия, минуты → интервал. */
function recordValue(column: PhysicalColumn): string {
  const value = `r.${ident(column.name)}`
  if (column.type === 'geometry') {
    return `extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(${value}::text), 4326)`
  }
  if (column.type === 'duration') return `make_interval(secs => ${value} * 60)`
  return value
}

export const Physical = {
  /** Таблица строк и (при trackHistory) таблица истории — в транзакции создания датасета. */
  async createTable(
    tx: Executor,
    datasetId: string,
    columns: PhysicalColumn[],
    options: { trackHistory: boolean; keyColumns: string[] },
  ): Promise<string> {
    const table = tableName(datasetId)
    await tx.execute(
      sql.raw(`CREATE TABLE ${qualified(table)} (
        _id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        _ver integer NOT NULL DEFAULT 1,
        _created_at timestamptz NOT NULL DEFAULT now(),
        _updated_at timestamptz NOT NULL DEFAULT now(),
        _created_by uuid,
        _updated_by uuid,
        _deleted_at timestamptz,
        _import_id uuid${columns.length > 0 ? `,\n        ${columnDefs(columns).join(',\n        ')}` : ''}
      )`),
    )
    for (const column of columns) {
      const statement = indexStatement(table, column)
      if (statement) await tx.execute(sql.raw(statement))
    }
    if (options.keyColumns.length > 0) {
      await tx.execute(sql.raw(keyIndexStatement(table, options.keyColumns)))
    }
    await Physical.grantRead(tx, table)
    if (options.trackHistory) await Physical.ensureHistory(tx, datasetId)
    return table
  },

  /** Таблица истории строк `ds.h_*` — при создании датасета или включении истории. */
  async ensureHistory(tx: Executor, datasetId: string): Promise<void> {
    const history = historyName(datasetId)
    await tx.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS ${qualified(history)} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        row_id bigint NOT NULL,
        ver integer NOT NULL,
        op char(1) NOT NULL,
        data jsonb,
        changed_by uuid,
        changed_at timestamptz NOT NULL DEFAULT now(),
        dataset_version integer
      )`),
    )
    await tx.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS ${ident(`${history}_row_idx`)} ON ${qualified(history)} (row_id, id)`,
      ),
    )
    await tx.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS ${ident(`${history}_version_idx`)} ON ${qualified(history)} (dataset_version)`,
      ),
    )
    await Physical.revokeQuery(tx, history)
  },

  /**
   * Таблицы истории, созданные до отката версий (ADR-0062), получают номер
   * версии датасета записи. Таблицы истории создаются на лету, поэтому это
   * проверка при старте, а не миграция схемы; повторный запуск ничего не меняет.
   */
  async upgradeHistoryTables(): Promise<number> {
    const missing = await rawSql()<Array<{ name: string }>>`
      SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ds' AND c.relkind = 'r' AND c.relname LIKE 'h\_%'
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'dataset_version' AND NOT a.attisdropped
         )`
    for (const { name } of missing) {
      await rawSql().unsafe(
        `ALTER TABLE ${qualified(name)} ADD COLUMN IF NOT EXISTS dataset_version integer`,
      )
      await rawSql().unsafe(
        `CREATE INDEX IF NOT EXISTS ${ident(`${name}_version_idx`)} ON ${qualified(name)} (dataset_version)`,
      )
    }
    return missing.length
  },

  /**
   * Полные уникальные индексы ключа, созданные до ADR-0160, — по живым строкам.
   * Таблицы строк создаются на лету, поэтому это проверка при старте, а не
   * миграция схемы (как у таблиц истории); повторный запуск ничего не меняет.
   */
  async upgradeKeyIndexes(): Promise<number> {
    const full = await rawSql()<Array<{ index: string; table: string; columns: string[] }>>`
      SELECT i.relname AS index, t.relname AS table,
             array_agg(a.attname::text ORDER BY k.ord) AS columns
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname = 'ds' AND x.indisunique AND NOT x.indisprimary AND x.indpred IS NULL
       GROUP BY i.relname, t.relname`
    let upgraded = 0
    for (const item of full) {
      if (!ROWS_TABLE.test(item.table)) continue
      await rawSql().begin(async (tx) => {
        await tx.unsafe(keyIndexStatement(item.table, item.columns))
        await tx.unsafe(`DROP INDEX ds.${ident(item.index)}`)
      })
      upgraded++
    }
    return upgraded
  },

  /** Чтение таблицы строк для пользовательских запросов и резервной роли. */
  async grantRead(tx: Executor, table: string): Promise<void> {
    await tx.execute(sql.raw(`GRANT SELECT ON ${qualified(table)} TO kchs_query, kchs_readonly`))
  },

  /** Служебная таблица закрыта для пользовательских запросов (снимает права по умолчанию). */
  async revokeQuery(executor: Executor, table: string): Promise<void> {
    await executor.execute(sql.raw(`REVOKE ALL ON ${qualified(table)} FROM kchs_query`))
  },

  async addColumn(tx: Executor, table: string, column: PhysicalColumn): Promise<void> {
    await tx.execute(
      sql.raw(`ALTER TABLE ${qualified(table)} ADD COLUMN ${columnDefs([column])[0]}`),
    )
    const statement = indexStatement(table, column)
    if (statement) await tx.execute(sql.raw(statement))
  },

  // ─── Правка схемы (ADR-0047) ──────────────────────────────────────────────

  async dropColumn(tx: Executor, table: string, column: string): Promise<void> {
    await tx.execute(sql.raw(`ALTER TABLE ${qualified(table)} DROP COLUMN ${ident(column)}`))
  },

  /** Индекс поля с `indexed` (для геометрии GIST создаётся всегда). */
  async createColumnIndex(tx: Executor, table: string, column: PhysicalColumn): Promise<void> {
    const statement = indexStatement(table, { ...column, indexed: true })
    if (statement) await tx.execute(sql.raw(statement))
  },

  /**
   * Одностолбцовые неуникальные индексы столбца. Имена индексов Postgres
   * выбирает сам (и меняет при подмене таблиц импорта) — ищем их по каталогу.
   */
  async dropColumnIndexes(tx: Executor, table: string, column: string): Promise<void> {
    const rows = await tx.execute<{ name: string }>(
      sql`SELECT i.relname AS name
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class t ON t.oid = x.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
           WHERE n.nspname = 'ds' AND t.relname = ${table} AND a.attname = ${column}
             AND x.indnatts = 1 AND NOT x.indisunique AND NOT x.indisprimary`,
    )
    for (const row of rows) await tx.execute(sql.raw(`DROP INDEX ds.${ident(row.name)}`))
  },

  /** Групп живых строк с одинаковым ключом (удалённые ключ не держат, ADR-0160). */
  async keyDuplicates(tx: Executor, table: string, keyColumns: string[]): Promise<number> {
    const keys = keyColumns.map(ident).join(', ')
    const [row] = await tx.execute<{ n: string }>(
      sql.raw(`SELECT count(*) AS n FROM (
                 SELECT 1 FROM ${qualified(table)} WHERE _deleted_at IS NULL
                  GROUP BY ${keys} HAVING count(*) > 1
               ) d`),
    )
    return Number(row?.n ?? 0)
  },

  /** Уникальный индекс ключа строки: прежний снимается, новый строится по ключу. */
  async replaceKeyIndex(tx: Executor, table: string, keyColumns: string[]): Promise<void> {
    const rows = await tx.execute<{ name: string }>(
      sql`SELECT i.relname AS name
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class t ON t.oid = x.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = 'ds' AND t.relname = ${table}
             AND x.indisunique AND NOT x.indisprimary`,
    )
    for (const row of rows) await tx.execute(sql.raw(`DROP INDEX ds.${ident(row.name)}`))
    if (keyColumns.length > 0) await tx.execute(sql.raw(keyIndexStatement(table, keyColumns)))
  },

  /** Сколько непустых значений не приводится к новому типу, и примеры. */
  async conversionReport(
    tx: Executor,
    table: string,
    cast: CastExpression,
  ): Promise<{ total: number; failed: number; sample: Array<{ rowId: string; value: string }> }> {
    const [counts] = await tx.execute<{ total: string; failed: string }>(
      sql.raw(`SELECT count(*) FILTER (WHERE ${cast.source} IS NOT NULL) AS total,
                      count(*) FILTER (WHERE ${cast.source} IS NOT NULL AND (${cast.expression}) IS NULL) AS failed
                 FROM ${qualified(table)} WHERE _deleted_at IS NULL`),
    )
    const sample = await tx.execute<{ row_id: string; value: string }>(
      sql.raw(`SELECT _id::text AS row_id, ${cast.source} AS value
                 FROM ${qualified(table)}
                WHERE _deleted_at IS NULL AND ${cast.source} IS NOT NULL AND (${cast.expression}) IS NULL
                ORDER BY _id LIMIT 20`),
    )
    return {
      total: Number(counts?.total ?? 0),
      failed: Number(counts?.failed ?? 0),
      sample: sample.map((row) => ({ rowId: row.row_id, value: row.value })),
    }
  },

  /** Смена типа столбца одной перезаписью таблицы; неприводимое становится NULL. */
  async convertColumn(
    tx: Executor,
    table: string,
    column: string,
    type: StoredFieldType,
    precision: number | undefined,
    cast: CastExpression,
  ): Promise<void> {
    await tx.execute(
      sql.raw(
        `ALTER TABLE ${qualified(table)} ALTER COLUMN ${ident(column)} TYPE ${columnType(type, precision)} USING ${cast.expression}`,
      ),
    )
  },

  /** Удаление физических таблиц — при окончательном удалении датасета. */
  async dropTables(tx: Executor, datasetId: string): Promise<void> {
    await tx.execute(sql.raw(`DROP TABLE IF EXISTS ${qualified(tableName(datasetId))}`))
    await tx.execute(sql.raw(`DROP TABLE IF EXISTS ${qualified(historyName(datasetId))}`))
  },

  // ─── Импорт: staging и коммит (ADR-0046) ────────────────────────────────────

  /**
   * Staging-таблица импорта: номер строки файла и столбцы в порядке
   * нормализованного CSV. UNLOGGED — это черновик, его не нужно реплицировать.
   */
  async createStaging(importId: string, columns: PhysicalColumn[]): Promise<string> {
    const staging = stagingName(importId)
    await rawSql().unsafe(
      `CREATE UNLOGGED TABLE ${qualified(staging)} (_row bigint NOT NULL${
        columns.length > 0 ? `, ${columnDefs(columns).join(', ')}` : ''
      })`,
    )
    await rawSql().unsafe(`REVOKE ALL ON ${qualified(staging)} FROM kchs_query`)
    return staging
  },

  /** Поток нормализованного CSV → `COPY … FROM STDIN (FORMAT csv)`. */
  async copyIntoStaging(staging: string, columns: string[], source: Readable): Promise<void> {
    const list = ['_row', ...columns].map(ident).join(', ')
    const writable = await rawSql()
      .unsafe(`COPY ${qualified(staging)} (${list}) FROM STDIN (FORMAT csv)`)
      .writable()
    await pipeline(source, writable)
  },

  async dropStaging(importId: string): Promise<void> {
    await rawSql().unsafe(`DROP TABLE IF EXISTS ${qualified(stagingName(importId))}`)
  },

  /**
   * Пачка строк внешнего источника → staging (ADR-0107): JSON одним параметром,
   * номера строк продолжают сквозную нумерацию пачек. Значения — параметром,
   * в текст запроса идут только проверенные имена столбцов.
   */
  async insertStagingJson(
    staging: string,
    columns: PhysicalColumn[],
    rows: Array<Record<string, unknown>>,
    firstRow: number,
  ): Promise<number> {
    if (rows.length === 0) return 0
    if (columns.length === 0) throw errors.internal('Нет столбцов для строк источника')
    const list = columns.map((column) => ident(column.name)).join(', ')
    const record = columns.map((column) => `${ident(column.name)} ${recordType(column)}`)
    const values = columns.map((column) => recordValue(column)).join(', ')
    const result = await rawSql().unsafe(
      `INSERT INTO ${qualified(staging)} (_row, ${list})
         SELECT $2::bigint + row_number() OVER (), ${values}
           FROM jsonb_to_recordset($1::jsonb) AS r(${record.join(', ')})`,
      [JSON.stringify(rows), String(firstRow)],
    )
    return result.count ?? rows.length
  },

  /**
   * Повторы ключа в staging: остаётся последняя строка файла, прочие — в
   * отчёт об ошибках. Возвращает номера отброшенных строк.
   */
  async dropDuplicateKeys(staging: string, keyColumns: string[]): Promise<number[]> {
    if (keyColumns.length === 0) return []
    const keys = keyColumns.map(ident).join(', ')
    const rows = await rawSql().unsafe<{ _row: string }[]>(
      `DELETE FROM ${qualified(staging)} s
        USING (
          SELECT _row, row_number() OVER (PARTITION BY ${keys} ORDER BY _row DESC) AS n
            FROM ${qualified(staging)}
        ) d
        WHERE s._row = d._row AND d.n > 1
        RETURNING s._row`,
    )
    return rows.map((row) => Number(row._row)).sort((a, b) => a - b)
  },

  /**
   * Полная замена (`replace`): новая таблица рядом, строки из staging, индексы и
   * статистика — вне транзакции коммита; сама подмена имён — быстрая, в ней.
   */
  async prepareReplacement(
    datasetId: string,
    staging: string,
    columns: string[],
    importId: string,
    userId: string | null,
  ): Promise<string> {
    const table = tableName(datasetId)
    const next = `${table}_n`
    await rawSql().unsafe(`DROP TABLE IF EXISTS ${qualified(next)}`)
    await rawSql().unsafe(
      `CREATE TABLE ${qualified(next)} (LIKE ${qualified(table)} INCLUDING ALL)`,
    )
    // До подмены таблица замены — черновик: читать её пользовательским запросам незачем
    await rawSql().unsafe(`REVOKE ALL ON ${qualified(next)} FROM kchs_query`)
    const list = columns.map(ident).join(', ')
    await rawSql().unsafe(
      `INSERT INTO ${qualified(next)} (${list}${columns.length ? ', ' : ''}_import_id, _created_by, _updated_by)
       SELECT ${list}${columns.length ? ', ' : ''}$1::uuid, $2::uuid, $2::uuid FROM ${qualified(staging)} ORDER BY _row`,
      [importId, userId],
    )
    await rawSql().unsafe(`ANALYZE ${qualified(next)}`)
    return next
  },

  /** Подмена таблиц в транзакции коммита: старая уходит, новая получает имя и права. */
  async swapReplacement(tx: Executor, datasetId: string): Promise<void> {
    const table = tableName(datasetId)
    await tx.execute(sql.raw(`DROP TABLE ${qualified(table)}`))
    await tx.execute(sql.raw(`ALTER TABLE ${qualified(`${table}_n`)} RENAME TO ${ident(table)}`))
    await Physical.grantRead(tx, table)
  },

  async dropReplacement(datasetId: string): Promise<void> {
    await rawSql().unsafe(`DROP TABLE IF EXISTS ${qualified(`${tableName(datasetId)}_n`)}`)
  },

  /** `append`: строки staging добавляются к таблице. */
  async append(
    tx: Executor,
    table: string,
    staging: string,
    columns: string[],
    importId: string,
    userId: string | null,
  ): Promise<number> {
    const list = columns.map(ident).join(', ')
    const result = await tx.execute(
      sql`INSERT INTO ${sql.raw(qualified(table))} (${sql.raw(list)}, _import_id, _created_by, _updated_by)
          SELECT ${sql.raw(list)}, ${importId}::uuid, ${userId}::uuid, ${userId}::uuid
            FROM ${sql.raw(qualified(staging))} ORDER BY _row`,
    )
    return result.count ?? 0
  },

  /**
   * `upsert` по ключу: новые строки добавляются, изменившиеся обновляются с
   * ростом `_ver`. Ключ, который есть только у удалённых строк, «воскрешает»
   * последнюю из них (история строки не рвётся); индекс ключа — по живым
   * строкам (ADR-0160), поэтому воскрешение — отдельным шагом до вставки.
   */
  async upsert(
    tx: Executor,
    table: string,
    staging: string,
    columns: string[],
    keyColumns: string[],
    importId: string,
    userId: string | null,
  ): Promise<{ inserted: number; updated: number }> {
    const list = columns.map(ident).join(', ')
    const keys = keyColumns.map(ident).join(', ')
    const t = qualified(table)
    const s = qualified(staging)
    const match = (a: string, b: string) =>
      keyColumns.map((c) => `${a}.${ident(c)} = ${b}.${ident(c)}`).join(' AND ')
    const valueColumns = columns.filter((column) => !keyColumns.includes(column))
    const restoreValues = valueColumns.map((c) => `${ident(c)} = s.${ident(c)}, `).join('')
    // Имена — только сгенерированные и проверенные `ident`; значения — параметрами
    const restored = await tx.execute(
      sql`UPDATE ${sql.raw(t)} AS t
             SET ${sql.raw(restoreValues)}_ver = t._ver + 1, _updated_at = now(),
                 _updated_by = ${userId}::uuid, _deleted_at = NULL, _import_id = ${importId}::uuid
            FROM ${sql.raw(s)} s
           WHERE t._deleted_at IS NOT NULL AND ${sql.raw(match('t', 's'))}
             AND t._id = (SELECT max(d._id) FROM ${sql.raw(t)} d
                           WHERE d._deleted_at IS NOT NULL AND ${sql.raw(match('d', 's'))})
             AND NOT EXISTS (SELECT 1 FROM ${sql.raw(t)} l
                              WHERE l._deleted_at IS NULL AND ${sql.raw(match('l', 's'))})`,
    )
    const assignments = valueColumns.map((column) => `${ident(column)} = EXCLUDED.${ident(column)}`)
    const changed =
      valueColumns.length > 0
        ? `(${valueColumns.map((c) => `t.${ident(c)}`).join(', ')}) IS DISTINCT FROM (${valueColumns
            .map((c) => `EXCLUDED.${ident(c)}`)
            .join(', ')})`
        : 'false'
    const setList = [
      ...assignments,
      '_ver = t._ver + 1',
      '_updated_at = now()',
      '_updated_by = EXCLUDED._updated_by',
      '_import_id = EXCLUDED._import_id',
    ].join(', ')
    // Воскрешённые строки уже живые и совпадают с файлом — повторно не обновляются
    const rows = await tx.execute<{ inserted: boolean }>(
      sql`INSERT INTO ${sql.raw(t)} AS t (${sql.raw(list)}, _import_id, _created_by, _updated_by)
          SELECT ${sql.raw(list)}, ${importId}::uuid, ${userId}::uuid, ${userId}::uuid
            FROM ${sql.raw(s)} ORDER BY _row
          ON CONFLICT (${sql.raw(keys)}) WHERE _deleted_at IS NULL DO UPDATE SET ${sql.raw(setList)}
          WHERE ${sql.raw(changed)}
          RETURNING (xmax = 0) AS inserted`,
    )
    let inserted = 0
    for (const row of rows) if (row.inserted) inserted++
    return { inserted, updated: rows.length - inserted + (restored.count ?? 0) }
  },

  /** `sync`: строки, которых нет в файле, помечаются удалёнными. */
  async markMissingDeleted(
    tx: Executor,
    table: string,
    staging: string,
    keyColumns: string[],
    userId: string | null,
  ): Promise<number> {
    const match = keyColumns.map((c) => `s.${ident(c)} = t.${ident(c)}`).join(' AND ')
    const result = await tx.execute(
      sql`UPDATE ${sql.raw(qualified(table))} t
             SET _deleted_at = now(), _updated_at = now(), _updated_by = ${userId}::uuid, _ver = t._ver + 1
           WHERE t._deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM ${sql.raw(qualified(staging))} s WHERE ${sql.raw(match)})`,
    )
    return result.count ?? 0
  },

  /**
   * Сводка изменений перед публикацией (ADR-0068): строки staging против
   * таблицы по ключу — так же, как их применил бы `upsert` (изменена строка,
   * если отличается хоть одно значение или она была удалена), и строки, которые
   * `sync` пометил бы удалёнными. Примеры — значения текстом, до `sampleRows` на вид.
   */
  async importDiff(input: {
    table: string
    staging: string
    columns: DiffColumn[]
    keyColumns: string[]
    sync: boolean
    sampleRows: number
  }): Promise<ImportDiffCounts> {
    const { table, staging, columns, keyColumns, sampleRows } = input
    const t = qualified(table)
    const s = qualified(staging)
    const match = keyColumns.map((c) => `s.${ident(c)} = t.${ident(c)}`).join(' AND ')
    // Строка ключа, как её выберет `upsert`: живая, иначе последняя удалённая (ADR-0160)
    const target = `LATERAL (SELECT * FROM ${t} t WHERE ${match}
                     ORDER BY (t._deleted_at IS NULL) DESC, t._id DESC LIMIT 1) t`
    const values = columns.filter((column) => !keyColumns.includes(column.physical))
    const changed =
      values.length > 0
        ? `((${values.map((c) => `t.${ident(c.physical)}`).join(', ')}) IS DISTINCT FROM (${values
            .map((c) => `s.${ident(c.physical)}`)
            .join(', ')}) OR t._deleted_at IS NOT NULL)`
        : 't._deleted_at IS NOT NULL'
    const keyText = (alias: string) =>
      `ARRAY[${keyColumns.map((c) => `left(${alias}.${ident(c)}::text, ${DIFF_TEXT_CHARS})`).join(', ')}]::text[]`
    const valueText = (alias: string) =>
      values.length > 0
        ? `ARRAY[${values.map((c) => diffText(alias, c)).join(', ')}]::text[]`
        : `'{}'::text[]`
    const distinct =
      values.length > 0
        ? `ARRAY[${values.map((c) => `t.${ident(c.physical)} IS DISTINCT FROM s.${ident(c.physical)}`).join(', ')}]::boolean[]`
        : `'{}'::boolean[]`

    // Имена — только сгенерированные и проверенные `ident`; число примеров — параметром
    const [counts] = await rawSql().unsafe<{ added: string; changed: string; unchanged: string }[]>(
      `SELECT count(*) FILTER (WHERE t._id IS NULL) AS added,
              count(*) FILTER (WHERE t._id IS NOT NULL AND ${changed}) AS changed,
              count(*) FILTER (WHERE t._id IS NOT NULL AND NOT ${changed}) AS unchanged
         FROM ${s} s LEFT JOIN ${target} ON true`,
    )
    const missing = `t._deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ${s} s WHERE ${match})`
    let deleted = 0
    if (input.sync) {
      const [row] = await rawSql().unsafe<{ n: string }[]>(
        `SELECT count(*) AS n FROM ${t} t WHERE ${missing}`,
      )
      deleted = Number(row?.n ?? 0)
    }

    const added = await rawSql().unsafe<DiffSampleRow[]>(
      `SELECT s._row AS row, ${keyText('s')} AS keys, NULL::text[] AS before,
              ${valueText('s')} AS after, NULL::boolean[] AS distinct, false AS restored
         FROM ${s} s LEFT JOIN ${target} ON true
        WHERE t._id IS NULL ORDER BY s._row LIMIT $1`,
      [sampleRows],
    )
    const updated = await rawSql().unsafe<DiffSampleRow[]>(
      `SELECT s._row AS row, ${keyText('s')} AS keys, ${valueText('t')} AS before,
              ${valueText('s')} AS after, ${distinct} AS distinct,
              t._deleted_at IS NOT NULL AS restored
         FROM ${s} s JOIN ${target} ON true
        WHERE ${changed} ORDER BY s._row LIMIT $1`,
      [sampleRows],
    )
    const removed = input.sync
      ? await rawSql().unsafe<DiffSampleRow[]>(
          `SELECT NULL::bigint AS row, ${keyText('t')} AS keys, ${valueText('t')} AS before,
                  NULL::text[] AS after, NULL::boolean[] AS distinct, false AS restored
             FROM ${t} t WHERE ${missing} ORDER BY t._id LIMIT $1`,
          [sampleRows],
        )
      : []
    const keys = values.map((column) => column.key)
    return {
      added: Number(counts?.added ?? 0),
      changed: Number(counts?.changed ?? 0),
      unchanged: Number(counts?.unchanged ?? 0),
      deleted,
      samples: {
        added: added.map((row) => diffSample(row, keys, 'added')),
        changed: updated.map((row) => diffSample(row, keys, 'changed')),
        deleted: removed.map((row) => diffSample(row, keys, 'deleted')),
      },
    }
  },

  // ─── Результат анализа (ADR-0069) ──────────────────────────────────────────

  /**
   * Пачка строк результата запроса → таблица датасета: одна пачка — один
   * параметр JSON (`jsonb_to_recordset`). Геометрия приходит GeoJSON,
   * длительность — числом минут (так её отдаёт компилятор запросов).
   */
  async insertJson(
    tx: Executor,
    table: string,
    columns: PhysicalColumn[],
    rows: Array<Record<string, unknown>>,
    userId: string | null,
  ): Promise<number> {
    if (rows.length === 0) return 0
    if (columns.length === 0) throw errors.internal('Нет столбцов для строк результата')
    const list = columns.map((column) => ident(column.name)).join(', ')
    const record = columns.map((column) => `${ident(column.name)} ${recordType(column)}`)
    const values = columns.map((column) => recordValue(column)).join(', ')
    const result = await tx.execute(
      sql`INSERT INTO ${sql.raw(qualified(table))} (${sql.raw(list)}, _created_by, _updated_by)
          SELECT ${sql.raw(values)}, ${userId}::uuid, ${userId}::uuid
            FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(${sql.raw(record.join(', '))})`,
    )
    return result.count ?? rows.length
  },

  /** Все строки таблицы — перед заменой результатом анализа (истории у таблицы нет). */
  async clearRows(tx: Executor, table: string): Promise<number> {
    const result = await tx.execute(sql.raw(`DELETE FROM ${qualified(table)}`))
    return result.count ?? 0
  },

  /** Точное число живых строк — после импорта и правок пакетом. */
  async countRows(tx: Executor, table: string): Promise<number> {
    const [row] = await tx.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::bigint AS n FROM ${qualified(table)} WHERE _deleted_at IS NULL`),
    )
    return Number(row?.n ?? 0)
  },

  async analyze(table: string): Promise<void> {
    await rawSql().unsafe(`ANALYZE ${qualified(table)}`)
  },
}
