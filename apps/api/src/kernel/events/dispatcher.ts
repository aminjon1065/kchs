import type { EventEnvelope } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { db, rawSql } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { redisPublisher } from '~/shared/redis/index.js'
import { xaddEvent } from './bus.js'

const BATCH_SIZE = 200
const IDLE_DELAY_MS = 200
const ERROR_DELAY_MS = 2000

let running = false
let stopped = false

/**
 * Диспетчер outbox: забирает неопубликованные записи с `FOR UPDATE SKIP LOCKED`,
 * публикует в Redis Streams, помечает отправленными (02-platform-kernel.md §4).
 * Всё — в одной транзакции: блокировки строк держатся до отметки, поэтому
 * параллельные диспетчеры не публикуют одно и то же. Падение между публикацией
 * и фиксацией приводит к повтору — подписчики идемпотентны.
 */
export async function dispatchOnce(): Promise<number> {
  const pub = redisPublisher()

  return rawSql().begin(async (tx) => {
    const rows = await tx<Array<{ id: number; event: EventEnvelope }>>`
      SELECT id, event FROM ops.outbox
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED`

    if (rows.length === 0) return 0

    const published: number[] = []
    for (const row of rows) {
      try {
        await xaddEvent(pub, row.event)
        published.push(row.id)
      } catch (error) {
        logger().error({ err: error, outboxId: row.id }, 'не удалось опубликовать событие')
        await tx`
          UPDATE ops.outbox
             SET attempts = attempts + 1,
                 last_error = ${error instanceof Error ? error.message : String(error)}
           WHERE id = ${row.id}`
        // Порядок событий важнее пропускной способности: остальные — в следующем проходе
        break
      }
    }

    if (published.length > 0) {
      await tx`UPDATE ops.outbox SET published_at = now() WHERE id IN ${tx(published)}`
    }
    return published.length
  })
}

export function startDispatcher(): void {
  if (running) return
  running = true
  stopped = false
  const log = logger().child({ module: 'outbox' })
  log.info('диспетчер outbox запущен')

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const count = await dispatchOnce()
        if (count === 0) await sleep(IDLE_DELAY_MS)
      } catch (error) {
        log.error({ err: error }, 'сбой диспетчера outbox')
        await sleep(ERROR_DELAY_MS)
      }
    }
    running = false
    log.info('диспетчер outbox остановлен')
  }

  void loop()
}

export function stopDispatcher(): void {
  stopped = true
}

/** Метрика здоровья: сколько событий ждут публикации и как долго. */
export async function outboxLag(): Promise<{ pending: number; oldestSeconds: number | null }> {
  const [row] = await db().execute<{ pending: string; oldest: number | null }>(sql`
    SELECT count(*)::text AS pending,
           EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest
      FROM ops.outbox WHERE published_at IS NULL`)
  return {
    pending: Number(row?.pending ?? 0),
    oldestSeconds: row?.oldest ?? null,
  }
}

/** Удаление опубликованных записей старше указанного срока (обслуживание). */
export async function pruneOutbox(olderThanHours = 72): Promise<number> {
  const result = await rawSql()`
    DELETE FROM ops.outbox
     WHERE published_at IS NOT NULL
       AND published_at < now() - make_interval(hours => ${olderThanHours})`
  return result.count
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
