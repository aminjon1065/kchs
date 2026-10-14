import type { EventEnvelope } from '@kchs/contracts'
import { desc, eq, like, sql } from 'drizzle-orm'
import { db, rawSql } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { redisPublisher } from '~/shared/redis/index.js'
import { addEvent } from './bus.js'
import { outbox } from './schema.js'

const BATCH_SIZE = 200
const IDLE_DELAY_MS = 200
const ERROR_DELAY_MS = 2000
/** Попыток у события, которое Redis отвергает само по себе, — потом карантин (ADR-0220). */
export const OUTBOX_MAX_ATTEMPTS = 10

let running = false
let stopped = false

type OutboxRow = { id: number; event: EventEnvelope; attempts: number }

/**
 * Диспетчер outbox: забирает неопубликованные записи с `FOR UPDATE SKIP LOCKED`,
 * публикует в Redis Streams одной пачкой (`pipeline`, порядок строк), помечает
 * отправленными (02-platform-kernel.md §4). Всё — в одной транзакции: блокировки строк
 * держатся до отметки, поэтому параллельные диспетчеры не публикуют одно и то же.
 * Падение между публикацией и фиксацией приводит к повтору — подписчики идемпотентны.
 *
 * Недоступный Redis или его состояние (нехватка памяти, загрузка, реплика) попыток не
 * тратят: события ждут Redis. Событие, которое Redis отвергает само по себе (не тот тип
 * ключа, неверная команда), — битое: попытка засчитывается, после
 * `OUTBOX_MAX_ATTEMPTS` оно уходит в карантин и больше не публикуется (ADR-0220).
 * Записи, принятые Redis, отмечаются отправленными все: повторная публикация лишь
 * задвоила бы их в потоке.
 */
export async function dispatchOnce(): Promise<number> {
  const pub = redisPublisher()

  return rawSql().begin(async (tx) => {
    const rows = await tx<OutboxRow[]>`
      SELECT id, event, attempts::int AS attempts FROM ops.outbox
       WHERE published_at IS NULL AND quarantined_at IS NULL
       ORDER BY id
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED`

    if (rows.length === 0) return 0

    const pipeline = pub.pipeline()
    for (const row of rows) addEvent(pipeline, row.event)
    // Сбой соединения — исключение: транзакция откатывается, строки ждут следующего прохода
    const results = (await pipeline.exec()) ?? []

    const published: number[] = []
    const failed: Array<{ row: OutboxRow; error: unknown }> = []
    rows.forEach((row, index) => {
      const error = results[index]?.[0] ?? (results[index] ? null : new Error('нет ответа Redis'))
      if (error) failed.push({ row, error })
      else published.push(row.id)
    })

    if (published.length > 0) {
      await tx`UPDATE ops.outbox SET published_at = now() WHERE id IN ${tx(published)}`
    }
    let rejected = 0
    for (const { row, error } of failed) {
      const message = error instanceof Error ? error.message : String(error)
      // Нехватка памяти, загрузка, реплика — беда Redis, а не события: попытка не тратится
      if (SYSTEMIC_REDIS_ERROR.test(message)) {
        logger().error({ err: error, outboxId: row.id }, 'Redis не принял событие outbox')
        continue
      }
      rejected += 1
      const quarantine = row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS
      await tx`
        UPDATE ops.outbox
           SET attempts = attempts + 1,
               last_error = ${message},
               quarantined_at = CASE WHEN ${quarantine} THEN now() END
         WHERE id = ${row.id}`
      logger().error(
        { err: error, outboxId: row.id, eventType: row.event.type, quarantine },
        quarantine ? 'событие outbox ушло в карантин' : 'не удалось опубликовать событие',
      )
    }
    // Отвергнутое событие — не повод ждать: следующий проход сразу. Сбой самого Redis —
    // пустой проход, диспетчер выжидает паузу
    return published.length + rejected
  })
}

/** Ответы Redis о его собственном состоянии, а не о команде (ADR-0220). */
const SYSTEMIC_REDIS_ERROR =
  /^(OOM|LOADING|READONLY|MASTERDOWN|BUSY|NOAUTH|NOPERM|CLUSTERDOWN|TRYAGAIN|MISCONF)\b/

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

/**
 * Метрика здоровья: сколько событий ждут публикации и как долго, сколько в карантине.
 * Карантин в «ждут» не входит: иначе одно битое событие навсегда держало бы оповещение
 * о застрявшем outbox, а не своё.
 */
export async function outboxLag(): Promise<{
  pending: number
  oldestSeconds: number | null
  quarantined: number
}> {
  const [row] = await db().execute<{
    pending: string
    oldest: number | null
    quarantined: string
  }>(sql`
    SELECT count(*) FILTER (WHERE quarantined_at IS NULL)::text AS pending,
           EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE quarantined_at IS NULL)))::int
             AS oldest,
           count(*) FILTER (WHERE quarantined_at IS NOT NULL)::text AS quarantined
      FROM ops.outbox WHERE published_at IS NULL`)
  return {
    pending: Number(row?.pending ?? 0),
    oldestSeconds: row?.oldest ?? null,
    quarantined: Number(row?.quarantined ?? 0),
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

/**
 * Последние события заданного типа из outbox — тестовый прогон правил
 * («что бы произошло», ADR-0096). Журнал хранится ограниченное время
 * (`outbox.prune`), поэтому это окно последних суток, а не вся история.
 */
export async function recentEvents(pattern: string, limit: number): Promise<EventEnvelope[]> {
  const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : null
  const rows = await db()
    .select({ event: outbox.event })
    .from(outbox)
    .where(prefix ? like(outbox.type, `${prefix}%`) : eq(outbox.type, pattern))
    .orderBy(desc(outbox.id))
    .limit(Math.min(limit, 100))
  return rows.map((row) => row.event as unknown as EventEnvelope)
}
