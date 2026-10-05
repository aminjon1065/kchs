import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'
import { ADVISORY_LOCKS } from './advisory.js'
import { applyGrants } from './grants.js'
import { ensureAuditPartitions } from './partitions.js'

/** Блокировка, чтобы несколько инстансов api не мигрировали одновременно. */
const ADVISORY_LOCK_ID = ADVISORY_LOCKS.migrations

/**
 * Каталог SQL-миграций: `KCHS_MIGRATIONS_DIR` или ближайший `drizzle` вверх от
 * этого файла — так он находится и из исходников, и из бандла `dist/` в образе.
 * Не найден — ошибка: тихий пропуск запустил бы приложение на пустой базе.
 */
export function migrationsDir(): string {
  const override = process.env.KCHS_MIGRATIONS_DIR
  if (override) return path.resolve(override)
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, 'drizzle')
    if (existsSync(path.join(candidate, 'meta'))) return candidate
    dir = path.dirname(dir)
  }
  throw new Error('каталог миграций drizzle не найден: задайте KCHS_MIGRATIONS_DIR')
}

export interface MigrationResult {
  applied: string[]
  skipped: number
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir)
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

    const done = new Map(
      (await sql<{ name: string; hash: string }[]>`SELECT name, hash FROM public.__migrations`).map(
        (r) => [r.name, r.hash],
      ),
    )
    const dir = migrationsDir()
    const files = await listMigrationFiles(dir)
    const bodies = new Map<string, string>()
    for (const file of files) bodies.set(file, await readFile(path.join(dir, file), 'utf8'))

    // Применённая миграция не меняется: правка файла задним числом означает, что
    // база и код разошлись, и молча продолжать нельзя (ADR-0173)
    const edited = files.filter((file) => {
      const recorded = done.get(file)
      return recorded !== undefined && recorded !== contentHash(bodies.get(file) ?? '')
    })
    if (edited.length > 0) throw new EditedMigrationError(edited, bodies)
    const unknown = [...done.keys()].filter((name) => !bodies.has(name))
    if (unknown.length > 0) {
      log.warn({ migrations: unknown }, 'в базе есть миграции, которых нет в этой версии кода')
    }

    const applied: string[] = []

    for (const file of files) {
      if (done.has(file)) continue
      const body = bodies.get(file) ?? ''
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

    // Партиции журнала аудита — на текущий и три следующих месяца при каждом старте;
    // ночное задание обслуживания делает то же для долго работающих установок (ADR-0173)
    const partitions = await ensureAuditPartitions(sql)
    if (partitions.created.length > 0) {
      log.info(partitions, 'партиции журнала аудита созданы')
    }

    return { applied, skipped: files.length - applied.length }
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`.catch(() => undefined)
    await sql.end({ timeout: 5 })
  }
}

/**
 * Отдельное соединение ролью-владельцем таблиц (kchs_migrator) — для обслуживания,
 * которое приложению запрещено: партиции журнала аудита (ADR-0173).
 */
export async function withMigratorConnection<T>(
  run: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const env = config()
  const sql = postgres(env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Файл уже применённой миграции изменён. Миграции после выпуска не правят — нужна
 * новая. Если правка сделана намеренно и база ей уже соответствует, хэш в журнале
 * миграций обновляют вручную — команда есть в тексте ошибки.
 */
export class EditedMigrationError extends Error {
  constructor(
    readonly files: string[],
    bodies: Map<string, string>,
  ) {
    const fixes = files
      .map(
        (file) =>
          `UPDATE public.__migrations SET hash = '${contentHash(bodies.get(file) ?? '')}' WHERE name = '${file}';`,
      )
      .join('\n')
    super(
      `Файлы применённых миграций изменены: ${files.join(', ')}. Применённую миграцию не ` +
        'правят — изменение схемы оформляют новой миграцией. Если правка намеренная и база ' +
        `ей уже соответствует, обновите хэш под ролью kchs_migrator:\n${fixes}`,
    )
    this.name = 'EditedMigrationError'
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
