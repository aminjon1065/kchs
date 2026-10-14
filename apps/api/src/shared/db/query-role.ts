import type postgres from 'postgres'
import { queryRoleSql } from './client.js'

/** Текст запроса и его параметры `$n`. */
export interface QueryText {
  sql: string
  params: readonly unknown[]
}

/** Столбец результата: имя и OID типа Postgres. */
export interface ResultColumn {
  name: string
  type: number
}

type Row = Record<string, unknown>

export interface ReadOptions {
  /** Тайм-аут оператора, мс. */
  timeoutMs: number
  /** Пояс сеанса: сырой SQL лаборатории считает даты в поясе пользователя. */
  timezone?: string | undefined
  /**
   * Сигнал задания (ADR-0220): отмена или предел времени прерывают идущий запрос в самой
   * базе (`pg_cancel_backend`), а не только перестают ждать его в процессе.
   */
  signal?: AbortSignal | undefined
}

/** Чтения одной транзакции роли `kchs_query`. */
export interface QueryReader {
  /** Строки объектами. */
  rows(query: QueryText): Promise<Row[]>
  /** Строки массивами значений по порядку столбцов и описание столбцов. */
  values(query: QueryText): Promise<{ rows: unknown[][]; columns: ResultColumn[] }>
  /** Курсор пачками по `batchSize` строк. */
  cursor(query: QueryText, batchSize: number): AsyncIterable<Row[]>
}

/**
 * Чтение под ролью `kchs_query` (17-security.md §4, ADR-0184) — единственное место,
 * где модули выполняют готовый текст SQL. Текст — от компилятора `@kchs/query`
 * (QuerySpec, сырой SQL лаборатории с подзапросами-политиками) или обёртка слоя
 * infra вокруг него (тайл, экстент слоя); значения — только параметрами `$n`.
 * Транзакция только для чтения, тайм-аут и пояс — её настройки: `set_config(…, true)`
 * живёт до конца транзакции и не достаётся следующему запросу соединения.
 */
export async function readAsQueryRole<T>(
  options: ReadOptions,
  run: (reader: QueryReader) => Promise<T>,
): Promise<T> {
  const signal = options.signal
  signal?.throwIfAborted()
  let stopWatching = () => {}
  try {
    return await queryRoleSql().begin('read only', async (sql) => {
      if (signal) stopWatching = await cancelOnAbort(sql, signal)
      return (await readIn(sql, options, run)) as never
    })
  } catch (error) {
    // Прерванный сигналом запрос — причина сигнала (отмена, предел задания), а не 57014
    if (signal?.aborted) throw signal.reason
    throw error
  } finally {
    stopWatching()
  }
}

/** Отмена задания — `pg_cancel_backend` процесса Postgres этой транзакции. */
async function cancelOnAbort(sql: postgres.TransactionSql, signal: AbortSignal) {
  const [row] = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
  const pid = row?.pid
  const onAbort = () => {
    if (pid === undefined) return
    void queryRoleSql()`SELECT pg_cancel_backend(${pid})`.catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

async function readIn<T>(
  sql: postgres.TransactionSql,
  options: ReadOptions,
  run: (reader: QueryReader) => Promise<T>,
): Promise<T> {
  if (options.timezone) {
    await sql`SELECT set_config('statement_timeout', ${String(options.timeoutMs)}, true),
                     set_config('TimeZone', ${options.timezone}, true)`
  } else {
    await sql`SELECT set_config('statement_timeout', ${String(options.timeoutMs)}, true)`
  }
  const params = (query: QueryText) => query.params as never[]
  return run({
    rows: async (query) => (await sql.unsafe(query.sql, params(query))) as unknown as Row[],
    async values(query) {
      const result = await sql.unsafe(query.sql, params(query)).values()
      const columns = (result as { columns?: ResultColumn[] }).columns ?? []
      return {
        rows: result as unknown as unknown[][],
        columns: columns.map((column) => ({ name: column.name, type: column.type })),
      }
    },
    cursor: (query, batchSize) =>
      sql.unsafe(query.sql, params(query)).cursor(batchSize) as unknown as AsyncIterable<Row[]>,
  })
}
