import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  SOURCE_PREVIEW_ROWS,
  SOURCE_PROBE_TIMEOUT_MS,
  type SourceColumn,
  type SourcePreview,
  type SourceQuery,
  type SourceTable,
  type StoredFieldType,
} from '@kchs/contracts'
import postgres from 'postgres'
import { config } from '~/shared/config/index.js'
import type { IntegrationRow } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { deniedAddress } from '~/shared/net/private-address.js'

/**
 * Внешняя СУБД как источник датасета (14-automation-integrations.md §5,
 * ADR-0107). Подключение и учётные данные живут в интеграции; здесь — разбор
 * конфигурации, защита от обращений внутрь периметра, ограничения и чтение.
 *
 * Имя узла разрешается заранее, и соединение идёт на проверенный адрес:
 * подмена DNS между проверкой и подключением ничего не даёт. Loopback и
 * link-local закрыты (как у вебхуков и прокси тайлов), частные сети открыты —
 * корпоративная база обычно в них.
 */

/** Виды интеграций, которые обслуживает этот модуль. */
export const DATABASE_KINDS = new Set(['postgres', 'mysql'])

/** Предел строк одного чтения: защита от случайной выгрузки склада. */
const STATEMENT_TIMEOUT_MS = 600_000
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

export interface DatabaseConfig {
  host: string
  port: number
  database: string
  user: string
  /** TLS: `require` — шифровать, `disable` — нет. */
  ssl: boolean
  /** Схема по умолчанию (PostgreSQL). */
  schema: string
}

function readConfig(row: IntegrationRow): DatabaseConfig {
  const raw = row.config as Record<string, unknown>
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const database = typeof raw.database === 'string' ? raw.database.trim() : ''
  const user = typeof raw.user === 'string' ? raw.user.trim() : ''
  if (!host) throw errors.validation('В конфигурации подключения нет поля host')
  if (!database) throw errors.validation('В конфигурации подключения нет поля database')
  if (!user) throw errors.validation('В конфигурации подключения нет поля user')
  const port = Number(raw.port ?? (row.kind === 'mysql' ? 3306 : 5432))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw errors.validation('Порт подключения — целое число от 1 до 65535')
  }
  const schema = typeof raw.schema === 'string' && raw.schema ? raw.schema : 'public'
  return { host, port, database, user, ssl: raw.ssl === true, schema }
}

/** Проверенный адрес узла: имя разрешается, служебные адреса закрыты. */
async function resolveHost(host: string): Promise<string> {
  const allowLoopback = config().NODE_ENV === 'test' || config().WEBHOOKS_ALLOW_PRIVATE_ADDRESSES
  if (isIP(host)) {
    if (deniedAddress(host, allowLoopback)) {
      throw errors.validation('Адрес базы закрыт для подключения')
    }
    return host
  }
  let records: { address: string }[]
  try {
    records = await lookup(host, { all: true })
  } catch {
    throw errors.validation(`Имя «${host}» не разрешается`)
  }
  const allowed = records.find((record) => !deniedAddress(record.address, allowLoopback))
  if (!allowed || records.some((record) => deniedAddress(record.address, allowLoopback))) {
    throw errors.validation('Имя базы указывает на служебный адрес — подключение закрыто')
  }
  return allowed.address
}

function quoteIdent(value: string, dialect: 'postgres' | 'mysql'): string {
  if (!IDENT.test(value)) throw errors.validation(`Недопустимое имя «${value}»`)
  return dialect === 'mysql' ? `\`${value}\`` : `"${value}"`
}

/**
 * Текст чтения: таблица или запрос пользователя как подзапрос. Значение
 * курсора уходит параметром — в текст запроса подставляются только проверенные
 * имена.
 */
const PG_CURSOR_CAST: Partial<Record<StoredFieldType, string>> = {
  datetime: 'timestamptz',
  date: 'date',
  time: 'time',
  integer: 'bigint',
  number: 'double precision',
  decimal: 'numeric',
  money: 'numeric',
  percent: 'double precision',
}

function selectText(
  query: SourceQuery,
  dialect: 'postgres' | 'mysql',
  options: {
    cursorField?: string | null
    cursorType?: StoredFieldType | undefined
    cursorValue?: string | null
    limit?: number | null
    defaultSchema: string
  },
): { sql: string; withCursor: boolean } {
  const from =
    query.kind === 'table'
      ? `${quoteIdent(query.schema || options.defaultSchema, dialect)}.${quoteIdent(query.table, dialect)}`
      : `(${query.sql}) AS kchs_src`
  const parts = [`SELECT * FROM ${from}`]
  // Первый инкремент читает всё: сравнивать не с чем
  const withCursor = Boolean(options.cursorField && options.cursorValue)
  if (options.cursorField) {
    const column = quoteIdent(options.cursorField, dialect)
    if (withCursor) {
      // Значение курсора всегда приходит текстом — приводим его к типу столбца
      const cast = PG_CURSOR_CAST[options.cursorType ?? 'text']
      const placeholder = dialect === 'mysql' ? '?' : cast ? `$1::text::${cast}` : '$1::text'
      parts.push(`WHERE ${column} > ${placeholder}`)
    }
    parts.push(`ORDER BY ${column} ASC`)
  }
  if (options.limit) parts.push(`LIMIT ${Math.trunc(options.limit)}`)
  return { sql: parts.join(' '), withCursor }
}

/** Тип столбца PostgreSQL (OID) → тип поля датасета. */
const PG_TYPE: Record<number, StoredFieldType> = {
  16: 'boolean',
  20: 'integer',
  21: 'integer',
  23: 'integer',
  700: 'number',
  701: 'number',
  1700: 'decimal',
  1082: 'date',
  1114: 'datetime',
  1184: 'datetime',
  1083: 'time',
  2950: 'text',
  114: 'json',
  3802: 'json',
}

/** Тип столбца MySQL → тип поля датасета (коды протокола). */
const MYSQL_TYPE: Record<number, StoredFieldType> = {
  0: 'decimal',
  1: 'integer',
  2: 'integer',
  3: 'integer',
  4: 'number',
  5: 'number',
  8: 'integer',
  9: 'integer',
  10: 'date',
  7: 'datetime',
  11: 'time',
  12: 'datetime',
  13: 'integer',
  246: 'decimal',
  245: 'json',
}

const columnKey = (name: string, taken: Set<string>): string => {
  let key = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) key = `f_${key}`.slice(0, 60)
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) key = 'field'
  let unique = key
  for (let n = 2; taken.has(unique); n++) unique = `${key}_${n}`
  taken.add(unique)
  return unique
}

/** Значение внешней базы → JSON для записи в датасет. */
export function externalValue(value: unknown, type: StoredFieldType): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  }
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

interface ReadRequest {
  query: SourceQuery
  cursorField?: string | null
  /** Тип поля-курсора: значение приходит текстом и приводится к нему. */
  cursorType?: StoredFieldType | undefined
  cursorValue?: string | null
  limit?: number | null
}

/** Драйвер подключения: свой для каждого вида СУБД. */
interface Driver {
  columns(request: ReadRequest): Promise<SourceColumn[]>
  rows(request: ReadRequest): Promise<Array<Record<string, unknown>>>
  stream(
    request: ReadRequest,
    onBatch: (rows: Array<Record<string, unknown>>) => Promise<void>,
    batchSize: number,
  ): Promise<void>
  tables(): Promise<SourceTable[]>
  close(): Promise<void>
}

async function postgresDriver(
  configuration: DatabaseConfig,
  address: string,
  password: string,
): Promise<Driver> {
  const sql = postgres({
    host: address,
    port: configuration.port,
    database: configuration.database,
    username: configuration.user,
    password,
    max: 1,
    prepare: false,
    connect_timeout: Math.ceil(SOURCE_PROBE_TIMEOUT_MS / 1000),
    idle_timeout: 20,
    // Потолок каждого запроса сессии (N79); поток в задании поднимает его у себя
    connection: { statement_timeout: config().EXTERNAL_DB_TIMEOUT_MS },
    ...(configuration.ssl ? { ssl: { servername: configuration.host } } : {}),
  })
  const text = (request: ReadRequest) =>
    selectText(request.query, 'postgres', {
      cursorField: request.cursorField ?? null,
      cursorType: request.cursorType,
      cursorValue: request.cursorValue ?? null,
      limit: request.limit ?? null,
      defaultSchema: configuration.schema,
    })
  const values = (request: ReadRequest) =>
    text(request).withCursor ? [request.cursorValue ?? ''] : []

  return {
    async columns(request) {
      const probe = await sql
        .unsafe(
          `SELECT * FROM (${text({ ...request, cursorField: null }).sql}) AS kchs_head LIMIT 0`,
        )
        .values()
      const columns = (probe as { columns?: Array<{ name: string; type: number }> }).columns ?? []
      const taken = new Set<string>()
      return columns.map((column) => ({
        name: column.name,
        nativeType: String(column.type),
        type: PG_TYPE[column.type] ?? 'text',
        key: columnKey(column.name, taken),
      }))
    },
    async rows(request) {
      const built = text(request)
      return (await sql.unsafe(built.sql, values(request) as never[])) as unknown as Array<
        Record<string, unknown>
      >
    },
    async stream(request, onBatch, batchSize) {
      const built = text(request)
      await sql.begin('read only', async (tx) => {
        await tx`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`
        const cursor = tx.unsafe(built.sql, values(request) as never[]).cursor(batchSize)
        for await (const batch of cursor) {
          await onBatch(batch as unknown as Array<Record<string, unknown>>)
        }
      })
    },
    async tables() {
      const rows = await sql<{ schema: string; table: string; rows: number | null }[]>`
        SELECT table_schema AS schema, table_name AS table, NULL::bigint AS rows
        FROM information_schema.tables
        WHERE table_type IN ('BASE TABLE', 'VIEW')
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name
        LIMIT 500`
      return rows.map((row) => ({ schema: row.schema, table: row.table, rows: row.rows }))
    },
    async close() {
      await sql.end({ timeout: 5 })
    },
  }
}

interface MysqlField {
  name: string
  type?: number
}

async function mysqlDriver(
  configuration: DatabaseConfig,
  address: string,
  password: string,
): Promise<Driver> {
  const mysql = await import('mysql2')
  const connection = mysql.createConnection({
    host: address,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password,
    connectTimeout: SOURCE_PROBE_TIMEOUT_MS,
    supportBigNumbers: true,
    // Соединяемся с проверенным адресом, а имя для сертификата — настоящее
    ...(configuration.ssl ? { ssl: { servername: configuration.host } as never } : {}),
  })
  const interactive = config().EXTERNAL_DB_TIMEOUT_MS
  // Потолок на стороне клиента — у каждого запроса; сервер MySQL прерывает SELECT
  // сам по max_execution_time (MariaDB такой переменной не знает — тогда хватит клиента)
  const run = (text: string, params: unknown[], timeout = interactive) =>
    new Promise<{ rows: Array<Record<string, unknown>>; fields: MysqlField[] }>(
      (resolve, reject) => {
        connection.query({ sql: text, timeout }, params, (error, rows, fields) => {
          if (error) reject(error)
          else
            resolve({
              rows: (rows ?? []) as unknown as Array<Record<string, unknown>>,
              fields: (fields ?? []) as unknown as MysqlField[],
            })
        })
      },
    )
  const text = (request: ReadRequest) =>
    selectText(request.query, 'mysql', {
      cursorField: request.cursorField ?? null,
      cursorType: request.cursorType,
      cursorValue: request.cursorValue ?? null,
      limit: request.limit ?? null,
      defaultSchema: configuration.database,
    })
  const values = (request: ReadRequest) =>
    text(request).withCursor ? [request.cursorValue ?? ''] : []
  const serverLimit = (ms: number) =>
    run('SET SESSION max_execution_time = ?', [ms]).catch(() => undefined)
  await serverLimit(interactive)

  return {
    async columns(request) {
      const built = text({ ...request, cursorField: null, limit: 1 })
      const { fields } = await run(built.sql, [])
      const taken = new Set<string>()
      return fields.map((field) => ({
        name: field.name,
        nativeType: String(field.type ?? ''),
        type: MYSQL_TYPE[Number(field.type ?? -1)] ?? 'text',
        key: columnKey(field.name, taken),
      }))
    },
    async rows(request) {
      const built = text(request)
      const { rows } = await run(built.sql, values(request))
      return rows
    },
    async stream(request, onBatch, batchSize) {
      const built = text(request)
      await serverLimit(STATEMENT_TIMEOUT_MS)
      const stream = connection
        .query({ sql: built.sql, timeout: STATEMENT_TIMEOUT_MS }, values(request))
        .stream()
      let batch: Array<Record<string, unknown>> = []
      for await (const row of stream) {
        batch.push(row as Record<string, unknown>)
        if (batch.length >= batchSize) {
          await onBatch(batch)
          batch = []
        }
      }
      if (batch.length > 0) await onBatch(batch)
    },
    async tables() {
      const { rows } = await run(
        `SELECT table_schema AS \`schema\`, table_name AS \`table\`, table_rows AS \`rows\`
         FROM information_schema.tables
         WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
         ORDER BY table_schema, table_name LIMIT 500`,
        [],
      )
      return rows.map((row) => ({
        schema: String(row.schema),
        table: String(row.table),
        rows: row.rows === null || row.rows === undefined ? null : Number(row.rows),
      }))
    },
    async close() {
      await new Promise<void>((resolve) => connection.end(() => resolve()))
    },
  }
}

/** Подключение по интеграции: конфигурация, адрес и драйвер вида СУБД. */
async function connect(row: IntegrationRow, secrets: Record<string, string>): Promise<Driver> {
  if (!DATABASE_KINDS.has(row.kind)) {
    throw errors.validation('Эта интеграция — не подключение к базе данных')
  }
  const configuration = readConfig(row)
  const address = await resolveHost(configuration.host)
  const password = secrets.password ?? ''
  return row.kind === 'mysql'
    ? mysqlDriver(configuration, address, password)
    : postgresDriver(configuration, address, password)
}

/**
 * Запрос прерван по времени: PostgreSQL `57014` (statement_timeout), MySQL 3024
 * (max_execution_time), MariaDB 1969, тайм-аут клиента mysql2.
 */
function timedOut(error: unknown): boolean {
  const code = (error as { code?: unknown; errno?: unknown } | null)?.code
  const errno = (error as { errno?: unknown } | null)?.errno
  return (
    code === '57014' ||
    code === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    code === 'ER_QUERY_TIMEOUT' ||
    errno === 3024 ||
    errno === 1969
  )
}

async function withDriver<T>(
  row: IntegrationRow,
  secrets: Record<string, string>,
  run: (driver: Driver) => Promise<T>,
): Promise<T> {
  const driver = await connect(row, secrets)
  try {
    return await run(driver)
  } catch (error) {
    if (timedOut(error)) {
      throw errors.queryTimeout(
        'Внешняя база не ответила вовремя: сузьте выборку, добавьте условие или индекс',
      )
    }
    throw error
  } finally {
    await driver.close().catch(() => undefined)
  }
}

/** Публичные действия над внешней базой — для модуля данных. */
export const ExternalDatabases = {
  /** Проверка связи: подключение и лёгкий запрос. */
  async check(
    row: IntegrationRow,
    secrets: Record<string, string>,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const tables = await withDriver(row, secrets, (driver) => driver.tables())
      return { ok: true, message: `Соединение установлено, таблиц: ${tables.length}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Нет соединения' }
    }
  },

  tables: (row: IntegrationRow, secrets: Record<string, string>): Promise<SourceTable[]> =>
    withDriver(row, secrets, (driver) => driver.tables()),

  /** Столбцы и первые строки выборки — мастеру настройки источника. */
  async preview(
    row: IntegrationRow,
    secrets: Record<string, string>,
    query: SourceQuery,
    limit: number,
  ): Promise<SourcePreview> {
    return withDriver(row, secrets, async (driver) => {
      const columns = await driver.columns({ query })
      const rows = await driver.rows({ query, limit: Math.min(limit, SOURCE_PREVIEW_ROWS) })
      return {
        columns,
        rows: rows.map((source) =>
          columns.map((column) => externalValue(source[column.name], column.type)),
        ),
      }
    })
  },

  columns: (
    row: IntegrationRow,
    secrets: Record<string, string>,
    query: SourceQuery,
  ): Promise<SourceColumn[]> => withDriver(row, secrets, (driver) => driver.columns({ query })),

  /** Потоковое чтение для задания синхронизации. */
  stream: (
    row: IntegrationRow,
    secrets: Record<string, string>,
    request: ReadRequest,
    onBatch: (rows: Array<Record<string, unknown>>) => Promise<void>,
    batchSize = 2000,
  ): Promise<void> =>
    withDriver(row, secrets, (driver) => driver.stream(request, onBatch, batchSize)),
}
