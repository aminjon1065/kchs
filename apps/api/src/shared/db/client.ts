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
  dbInstance = drizzle(sqlClient, { schema, logger: false })
  return dbInstance
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

export function queryRoleSql(): postgres.Sql {
  if (queryClient) return queryClient
  const env = config()
  const url = env.DATABASE_QUERY_URL ?? env.DATABASE_URL
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
