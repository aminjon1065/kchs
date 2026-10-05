import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'
import * as schema from './schema/index.js'

export type Database = PostgresJsDatabase<typeof schema>
/** Транзакционный контекст: сервисы ядра принимают его первым аргументом. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Любой исполнитель запросов: база или транзакция. */
export type Executor = Database | Tx

let sqlClient: postgres.Sql | null = null
let dbInstance: Database | null = null

function createClient(url: string, max: number): postgres.Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    prepare: true,
    onnotice: (notice) => logger().debug({ notice }, 'postgres notice'),
    types: {
      // bigint как число: значения ядра не превышают 2^53
      bigint: postgres.BigInt,
    },
  })
}

export function db(): Database {
  if (dbInstance) return dbInstance
  const env = config()
  sqlClient = createClient(env.DATABASE_URL, env.DATABASE_POOL_MAX)
  dbInstance = trackCommits(drizzle(sqlClient, { schema, logger: false }))
  return dbInstance
}

// ─── После фиксации ──────────────────────────────────────────────────────────

type CommitCallback = () => unknown

/** Действия после фиксации внешней транзакции; ключ — объект транзакции drizzle. */
const commitQueues = new WeakMap<object, CommitCallback[]>()

/**
 * Транзакции базы запоминают действия `afterCommit` (ADR-0177) и выполняют их
 * после фиксации. Откат их отбрасывает.
 */
function trackCommits(database: Database): Database {
  const begin = database.transaction.bind(database)
  database.transaction = (async (run, transactionConfig) => {
    const queue: CommitCallback[] = []
    const result = await begin(async (tx) => {
      track(tx, queue)
      return run(tx)
    }, transactionConfig)
    await runCommitted(queue)
    return result
  }) as Database['transaction']
  return database
}

/**
 * Точка сохранения (вложенная транзакция): её действия переходят во внешнюю
 * транзакцию, только если точка удалась — откат точки их отбрасывает.
 */
function track(tx: Tx, queue: CommitCallback[]): void {
  commitQueues.set(tx, queue)
  const savepoint = tx.transaction.bind(tx)
  tx.transaction = (<T>(run: (inner: Tx) => Promise<T>) =>
    savepoint(async (inner) => {
      const nested: CommitCallback[] = []
      track(inner as Tx, nested)
      const result = await run(inner as Tx)
      queue.push(...nested)
      return result
    })) as Tx['transaction']
}

async function runCommitted(queue: CommitCallback[]): Promise<void> {
  for (const callback of queue) {
    try {
      await callback()
    } catch (error) {
      // Транзакция уже зафиксирована: сбой действия после неё — в журнал, не вызывающему
      logger().error({ err: error }, 'действие после фиксации транзакции не выполнено')
    }
  }
}

/**
 * Выполнить после фиксации транзакции (ADR-0177): сброс кэша и подобное, что до
 * коммита дало бы гонку — параллельный запрос успел бы закэшировать прежнее
 * состояние под новой меткой. На откате действие отбрасывается. Вне транзакции
 * (передана сама база или транзакция не из `db()`) — сразу.
 */
export async function afterCommit(executor: Executor, callback: CommitCallback): Promise<void> {
  const queue = commitQueues.get(executor)
  if (queue) {
    queue.push(callback)
    return
  }
  await callback()
}

export function rawSql(): postgres.Sql {
  if (!sqlClient) db()
  return sqlClient!
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 })
    sqlClient = null
    dbInstance = null
  }
}

/** Отдельный пул под ролью kchs_query для пользовательских запросов (фаза 1). */
let queryClient: postgres.Sql | null = null

/**
 * @public — пул SQL-песочницы датасетов (P1-E04, 17-security.md §4): пользовательский
 * SQL выполняется только под ролью kchs_query; закрытие пула уже встроено в main.ts.
 */
export function queryRoleSql(): postgres.Sql {
  if (queryClient) return queryClient
  // Без отдельной роли запросы пользователей выполнялись бы с правами приложения —
  // подмены нет ни в одном окружении (17-security.md §4)
  const url = config().DATABASE_QUERY_URL
  if (!url) {
    throw new Error(
      'DATABASE_QUERY_URL не задан: запросы к данным выполняются только под kchs_query',
    )
  }
  queryClient = postgres(url, { max: 8, idle_timeout: 20, prepare: false })
  return queryClient
}

export async function closeQueryRole(): Promise<void> {
  if (queryClient) {
    await queryClient.end({ timeout: 5 })
    queryClient = null
  }
}

export { schema }
