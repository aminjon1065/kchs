import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'
import { db, type Executor } from '~/shared/db/client.js'
import { eventInstances, events } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import {
  expandSeries,
  HORIZON_MS,
  MAX_OCCURRENCES,
  type Occurrence,
  type OccurrenceOverride,
  type Series,
} from './recurrence.js'
import { addDays, DAY_MS, iso } from './time.js'

export type EventRow = typeof events.$inferSelect

/**
 * С какого момента материализуются экземпляры давней серии: старше ~13 месяцев
 * история не разворачивается (просмотр прошлого — редкость, а предел числа
 * экземпляров иначе съедался бы давно прошедшими повторами).
 */
const HISTORY_MS = 400 * DAY_MS
/** Продление горизонта — когда до его края остаётся меньше месяца. */
const EXTEND_MARGIN_MS = 30 * DAY_MS

export function seriesOf(row: EventRow): Series {
  return {
    allDay: row.allDay,
    startsAt: Date.parse(row.startsAt),
    endsAt: Date.parse(row.endsAt),
    startDate: row.startDate,
    endDate: row.endDate,
    timezone: row.timezone,
    rrule: row.rrule,
    exdates: row.exdates,
    overrides: row.overrides as Record<string, OccurrenceOverride>,
  }
}

function instanceValues(row: EventRow, occurrence: Occurrence) {
  return {
    eventId: row.id,
    calendarId: row.calendarId,
    recurrenceId: iso(occurrence.recurrenceId),
    startsAt: iso(occurrence.startsAt),
    endsAt: iso(occurrence.endsAt),
    allDay: row.allDay,
    startDate: occurrence.startDate,
    endDate: occurrence.endDate,
    overridden: occurrence.overridden,
  }
}

async function insertOccurrences(
  tx: Executor,
  row: EventRow,
  occurrences: Occurrence[],
): Promise<void> {
  for (let index = 0; index < occurrences.length; index += 500) {
    const chunk = occurrences.slice(index, index + 500)
    if (chunk.length === 0) continue
    await tx
      .insert(eventInstances)
      .values(chunk.map((occurrence) => instanceValues(row, occurrence)))
      .onConflictDoNothing()
  }
}

/**
 * Экземпляры события заново (правка серии): до горизонта в два года, давняя
 * история — не глубже ~13 месяцев назад. Бесконечная серия запоминает, до
 * какого момента развёрнута, — горизонт продлевает задание.
 */
export async function materialize(tx: Executor, row: EventRow, now = Date.now()): Promise<void> {
  const horizon = now + HORIZON_MS
  const series = seriesOf(row)
  const from = row.rrule && series.startsAt < now - HISTORY_MS ? now - HISTORY_MS : undefined
  const { occurrences, complete } = expandSeries(series, horizon, MAX_OCCURRENCES, from)
  await tx.delete(eventInstances).where(eq(eventInstances.eventId, row.id))
  await insertOccurrences(tx, row, occurrences)
  const materializedUntil = row.rrule && !complete ? iso(horizon) : null
  if (materializedUntil !== row.materializedUntil) {
    await tx.update(events).set({ materializedUntil }).where(eq(events.id, row.id))
  }
}

/**
 * Продление горизонта бесконечных серий (задание раз в сутки): экземпляры от
 * прежнего края до нового, существующие не трогаются.
 */
export async function extendHorizons(now = Date.now()): Promise<number> {
  const rows = await db()
    .select()
    .from(events)
    .where(
      and(
        isNotNull(events.rrule),
        isNotNull(events.materializedUntil),
        lt(events.materializedUntil, iso(now + HORIZON_MS - EXTEND_MARGIN_MS)),
      ),
    )
    .limit(500)
  let extended = 0
  for (const row of rows) {
    try {
      await db().transaction(async (tx) => {
        const horizon = now + HORIZON_MS
        const from = Date.parse(row.materializedUntil ?? iso(now))
        const { occurrences, complete } = expandSeries(
          seriesOf(row),
          horizon,
          MAX_OCCURRENCES,
          from,
        )
        await insertOccurrences(
          tx,
          row,
          occurrences.filter((occurrence) => occurrence.recurrenceId > from),
        )
        await tx
          .update(events)
          .set({ materializedUntil: complete ? null : iso(horizon) })
          .where(eq(events.id, row.id))
      })
      extended += 1
    } catch (error) {
      logger().warn({ err: error, eventId: row.id }, 'горизонт серии не продлён')
    }
  }
  return extended
}

/** Экземпляр серии по исходному началу — пересчёт после правки одного повторения. */
export async function rematerializeOccurrence(
  tx: Executor,
  row: EventRow,
  occurrence: Occurrence | null,
  recurrenceId: string,
): Promise<void> {
  await tx
    .delete(eventInstances)
    .where(and(eq(eventInstances.eventId, row.id), eq(eventInstances.recurrenceId, recurrenceId)))
  if (occurrence) await insertOccurrences(tx, row, [occurrence])
}

/** Дата окончания события на весь день во внешнем виде — последний день включительно. */
export function inclusiveEnd(endDate: string | null): string | null {
  return endDate ? addDays(endDate, -1) : null
}

export const overlaps = (from: string, to: string) =>
  sql`tstzrange(${eventInstances.startsAt}, ${eventInstances.endsAt}, '[)') && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`
