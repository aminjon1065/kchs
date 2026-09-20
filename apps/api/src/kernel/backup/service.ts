import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { desc, eq, sql } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { actorId, systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { backups } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { buckets, deleteObject, ensureBucket, putStream } from '../storage/s3.js'

/**
 * Резервные копии базы (15-admin-operations.md §5): установка S1 делает их
 * сама — `pg_dump -Fc` пишется прямо в бакет копий, запись о прогоне остаётся
 * в `ops.backups`. Проверку восстановлением ставит человек по runbook. Для S2
 * остаётся pgBackRest с непрерывным архивом WAL.
 */

/** Сколько удачных копий хранится: лишние удаляются вместе с архивами. */
const KEEP = 7
/** Дольше этого прогон считается прерванным (процесс остановили посреди дампа). */
const STALE_MINUTES = 60

export interface BackupRecord {
  id: string
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt: string | null
  sizeBytes: number | null
  requestedBy: string | null
  error: string | null
  verifiedAt: string | null
  verifiedNote: string | null
}

function row(value: typeof backups.$inferSelect): BackupRecord {
  return {
    id: value.id,
    status: value.status as BackupRecord['status'],
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    sizeBytes: value.sizeBytes,
    requestedBy: value.requestedBy,
    error: value.error,
    verifiedAt: value.verifiedAt,
    verifiedNote: value.verifiedNote,
  }
}

/** `pg_dump` пишет в поток, поток уходит в бакет; причина отказа — из stderr. */
async function dumpTo(key: string): Promise<number> {
  const env = config()
  await ensureBucket(buckets.backups())
  const stream = new PassThrough()
  // Отказ приходит в поток: без своего слушателя `destroy(err)` падал бы
  // необработанным исключением процесса, пока выгрузка ещё не подписалась
  stream.on('error', () => undefined)
  const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', env.DATABASE_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000)
  })
  child.stdout.pipe(stream)

  // Код завершения ждём отдельно: поток может кончиться раньше, чем процесс,
  // и оборванный дамп иначе уехал бы в бакет как удачная копия
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  child.on('error', (error) => {
    const reason =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('pg_dump не найден: нужен клиент PostgreSQL той же версии, что и сервер')
        : error
    stream.destroy(reason)
  })

  const size = await putStream(key, stream, {
    bucket: buckets.backups(),
    contentType: 'application/octet-stream',
  })
  const code = await closed
  if (code !== 0) throw new Error(stderr.trim() || `pg_dump завершился с ${code}`)
  return size
}

export const BackupService = {
  /** Прогоны, новые сверху. */
  async list(limit = 20): Promise<BackupRecord[]> {
    const rows = await db()
      .select()
      .from(backups)
      .orderBy(desc(backups.startedAt))
      .limit(Math.min(limit, 100))
    return rows.map(row)
  },

  /**
   * Копия целиком: запись «в работе» → дамп в бакет → итог. Ошибка не летит
   * наружу — она остаётся в записи прогона: иначе задание ушло бы в повтор и
   * било бы по базе раз за разом.
   */
  async run(ctx: Ctx | null): Promise<BackupRecord> {
    const id = randomUUID()
    const key = `pg/${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}-${id}.dump`
    const requestedBy = ctx ? actorId(ctx) : null
    // Копия по расписанию идёт без человека, но в аудите она нужна так же:
    // иначе «копий не делалось» и «расписание выключили» выглядят одинаково
    const auditCtx = ctx ?? systemCtx('backup.run')
    await db().insert(backups).values({ id, status: 'running', key, requestedBy })

    try {
      const sizeBytes = await dumpTo(key)
      await db()
        .update(backups)
        .set({ status: 'done', finishedAt: sql`now()`, sizeBytes })
        .where(eq(backups.id, id))
      await audit(auditCtx, {
        action: AUDIT_ACTIONS.backupCreated,
        severity: 'notice',
        details: { backupId: id, sizeBytes, scheduled: ctx === null },
      })
      await this.prune()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger().error({ err: error, backupId: id }, 'резервная копия не сделана')
      await db()
        .update(backups)
        .set({ status: 'failed', finishedAt: sql`now()`, error: message.slice(0, 2000) })
        .where(eq(backups.id, id))
      // Несделанная копия — событие безопасности: серия отказов означает, что
      // восстанавливать будет нечего, и заметить это должен мониторинг аудита
      await audit(auditCtx, {
        action: AUDIT_ACTIONS.backupFailed,
        severity: 'warning',
        details: { backupId: id, scheduled: ctx === null, reason: message.slice(0, 500) },
      })
      await deleteObject(key, buckets.backups()).catch(() => undefined)
    }

    const [saved] = await db().select().from(backups).where(eq(backups.id, id)).limit(1)
    return row(saved as typeof backups.$inferSelect)
  },

  /** Отметка «проверено восстановлением» (runbook): когда, кто и с каким примечанием. */
  async markVerified(ctx: Ctx, id: string, note: string): Promise<BackupRecord | null> {
    const [saved] = await db()
      .update(backups)
      .set({ verifiedAt: sql`now()`, verifiedBy: actorId(ctx), verifiedNote: note.slice(0, 500) })
      .where(eq(backups.id, id))
      .returning()
    if (!saved) return null
    await audit(ctx, {
      action: AUDIT_ACTIONS.backupVerified,
      severity: 'notice',
      details: { backupId: id, note },
    })
    return row(saved)
  },

  /** Хранение: всё, что старше KEEP удачных копий, удаляется вместе с архивом. */
  async prune(): Promise<number> {
    const rows = await db()
      .select({ id: backups.id, key: backups.key })
      .from(backups)
      .where(eq(backups.status, 'done'))
      .orderBy(desc(backups.startedAt))
      .offset(KEEP)
    for (const item of rows) {
      if (item.key) await deleteObject(item.key, buckets.backups()).catch(() => undefined)
      await db().delete(backups).where(eq(backups.id, item.id))
    }
    return rows.length
  },

  /** Прерванные прогоны (процесс остановили посреди дампа) — в ошибку при старте воркера. */
  async failStale(): Promise<number> {
    const rows = await db()
      .update(backups)
      .set({
        status: 'failed',
        finishedAt: sql`now()`,
        error: 'прогон прерван: процесс остановлен',
      })
      .where(
        sql`${backups.status} = 'running' and ${backups.startedAt} < now() - make_interval(mins => ${STALE_MINUTES})`,
      )
      .returning({ id: backups.id })
    return rows.length
  },
}
