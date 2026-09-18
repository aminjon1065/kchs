import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'
import { applyGrants } from './grants.js'

/** Блокировка, чтобы несколько инстансов api не мигрировали одновременно. */
const ADVISORY_LOCK_ID = 725_130_001

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle',
)

export interface MigrationResult {
  applied: string[]
  skipped: number
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[])
  return entries.filter((f) => f.endsWith('.sql')).sort()
}

/**
 * Применяет SQL-миграции по порядку под ролью kchs_migrator.
 * Идемпотентно: повторный запуск ничего не делает.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const env = config()
  const url = env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  const log = logger().child({ module: 'migrate' })

  try {
    await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_ID})`
    await sql`
      CREATE TABLE IF NOT EXISTS public.__migrations (
        name text PRIMARY KEY,
        hash text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`

    const done = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM public.__migrations`).map((r) => r.name),
    )
    const files = await listMigrationFiles(MIGRATIONS_DIR)
    const applied: string[] = []

    for (const file of files) {
      if (done.has(file)) continue
      const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      const hash = contentHash(body)
      log.info({ migration: file }, 'применяю миграцию')
      await sql.begin(async (tx) => {
        // statement-breakpoint — разделитель, который ставит drizzle-kit
        const statements = body
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean)
        for (const statement of statements) {
          await tx.unsafe(statement)
        }
        await tx`INSERT INTO public.__migrations (name, hash) VALUES (${file}, ${hash})`
      })
      applied.push(file)
    }

    if (applied.length === 0) log.info('миграции: изменений нет')
    else log.info({ count: applied.length }, 'миграции применены')

    // Привилегии синхронизируются всегда: новые таблицы должны быть доступны
    // приложению и недоступны роли пользовательских запросов.
    await applyGrants(sql)
    log.info('привилегии ролей синхронизированы')

    return { applied, skipped: files.length - applied.length }
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`.catch(() => undefined)
    await sql.end({ timeout: 5 })
  }
}

/** Небольшой стабильный хэш содержимого миграции (для обнаружения правок). */
function contentHash(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}
