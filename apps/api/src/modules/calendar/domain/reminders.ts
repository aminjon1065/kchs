import { and, eq, isNull, type SQL, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  eventAttendees,
  eventInstances,
  eventReminders,
  events,
  objects,
} from '~/shared/db/schema/index.js'

/**
 * Напоминания (12-calendar-notifications-home.md §1, ADR-0081). Очередь
 * `event_reminders` держит срабатывания ближайших суток: экземпляр × участник ×
 * напоминание (своё у участника или напоминание события). Отправка — задание
 * раз в минуту: строки захватываются `FOR UPDATE SKIP LOCKED`, отметка
 * `sent_at` и событие `event.reminder` пишутся одной транзакцией — перезапуск
 * worker или два исполнителя не дают повтора; доставку делает подписчик через
 * уведомления ядра.
 */

/** Опоздавшее напоминание (worker был остановлен) отправляется не позже 15 минут. */
const LATE = sql`interval '15 minutes'`
/** Планируются срабатывания ближайших суток с запасом на период задания. */
const AHEAD = sql`interval '25 hours'`
/** Самое раннее напоминание — за неделю до начала. */
const LONGEST = sql`interval '7 days'`

function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
}

/**
 * Запланировать срабатывания ближайших суток: для событий из списка или для
 * всех. Идемпотентно — уже запланированные и отправленные не повторяются.
 */
export async function planReminders(
  executor: Executor,
  eventIds: string[] | null,
  userId?: string,
): Promise<number> {
  if (eventIds && eventIds.length === 0) return 0
  const byEvent = eventIds ? sql`AND i.event_id IN (${idList(eventIds)})` : sql``
  const byUser = userId ? sql`AND a.user_id = ${userId}` : sql``
  const rows = await executor.execute<{ id: number }>(sql`
    INSERT INTO ${eventReminders}
      (event_id, user_id, recurrence_id, starts_at, minutes, channels, fire_at)
    SELECT i.event_id, a.user_id, i.recurrence_id, i.starts_at, r.minutes, r.channels,
           i.starts_at - make_interval(mins => r.minutes)
      FROM ${eventInstances} i
      JOIN ${events} e ON e.id = i.event_id
      JOIN ${objects} o ON o.id = e.id AND o.deleted_at IS NULL
      JOIN ${eventAttendees} a ON a.event_id = e.id AND a.status <> 'declined'
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(a.reminders, e.reminders))
        AS r(minutes int, channels text[])
     WHERE i.starts_at > now() - ${LATE}
       AND i.starts_at <= now() + ${AHEAD} + ${LONGEST}
       AND r.minutes BETWEEN 0 AND 10080
       AND cardinality(r.channels) > 0
       AND i.starts_at - make_interval(mins => r.minutes) > now() - ${LATE}
       AND i.starts_at - make_interval(mins => r.minutes) <= now() + ${AHEAD}
       ${byEvent} ${byUser}
    ON CONFLICT DO NOTHING
    RETURNING id`)
  return rows.length
}

/** Правка события: неотправленные напоминания — заново по новому времени и составу. */
export async function replanReminders(executor: Executor, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return
  await executor
    .delete(eventReminders)
    .where(
      and(sql`${eventReminders.eventId} IN (${idList(eventIds)})`, isNull(eventReminders.sentAt)),
    )
  await planReminders(executor, eventIds)
}

/** Участник отказался или исключён — его неотправленные напоминания снимаются. */
export async function dropReminders(
  executor: Executor,
  eventId: string,
  userId?: string,
): Promise<void> {
  await executor
    .delete(eventReminders)
    .where(
      and(
        eq(eventReminders.eventId, eventId),
        isNull(eventReminders.sentAt),
        userId ? eq(eventReminders.userId, userId) : undefined,
      ),
    )
}

interface DueRow extends Record<string, unknown> {
  event_id: string
  user_id: string
  recurrence_id: string | Date
  starts_at: string | Date
  minutes: number
  channels: string[]
  title: string
  space_id: string | null
}

const isoOf = (value: string | Date) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

/**
 * Отправка наступивших напоминаний: захват, отметка и события — одной
 * транзакцией. Удалённые события и начавшиеся встречи пропускаются.
 */
export async function dispatchDueReminders(limit = 500): Promise<number> {
  return db().transaction(async (tx) => {
    const rows = await tx.execute<DueRow>(sql`
      WITH due AS (
        SELECT r.id
          FROM ${eventReminders} r
          JOIN ${objects} o ON o.id = r.event_id AND o.deleted_at IS NULL
         WHERE r.sent_at IS NULL
           AND r.fire_at <= now()
           AND r.fire_at > now() - ${LATE}
           AND r.starts_at > now() - interval '5 minutes'
         ORDER BY r.fire_at
         LIMIT ${limit}
         FOR UPDATE OF r SKIP LOCKED
      ), sent AS (
        UPDATE ${eventReminders} r SET sent_at = now()
          FROM due WHERE r.id = due.id
        RETURNING r.event_id, r.user_id, r.recurrence_id, r.starts_at, r.minutes, r.channels
      )
      SELECT sent.*, o.title, o.space_id
        FROM sent JOIN ${objects} o ON o.id = sent.event_id`)
    const ctx = systemCtx('calendar.reminders')
    for (const row of rows) {
      await publishEvent(tx, ctx, {
        type: 'event.reminder',
        object: { id: row.event_id, type: 'event', spaceId: row.space_id, title: row.title },
        payload: {
          userId: row.user_id,
          occurrenceStart: isoOf(row.starts_at),
          minutes: row.minutes,
          channels: row.channels,
        },
      })
    }
    return rows.length
  })
}

/** Очистка: отправленные старше недели и пропущенные (опоздали больше чем на час). */
export async function pruneReminders(): Promise<number> {
  const rows = await db()
    .delete(eventReminders)
    .where(
      sql`(${eventReminders.sentAt} < now() - interval '7 days')
        OR (${eventReminders.sentAt} IS NULL AND ${eventReminders.fireAt} < now() - interval '1 hour')`,
    )
    .returning({ id: eventReminders.id })
  return rows.length
}
