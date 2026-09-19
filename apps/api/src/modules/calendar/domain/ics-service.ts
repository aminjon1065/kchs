import {
  atLeast,
  type CalendarFeed,
  type CalendarFeedCreated,
  type CalendarImportResult,
  type Level,
  type Locale,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { config } from '~/shared/config/index.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { decryptSecret, hashToken } from '~/shared/crypto/secrets.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  calendarFeeds,
  calendars,
  eventAttendees,
  eventInstances,
  events,
  objects,
} from '~/shared/db/schema/index.js'
import { errors, isAppError } from '~/shared/errors.js'
import { newId, randomToken } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { type CalendarRow, loadCalendar, principalUser } from './calendar-service.js'
import { insertEvent } from './event-service.js'
import { buildCalendar, type IcsEvent, type ParsedEvent, parseCalendar } from './ics.js'
import { fetchIcs } from './ics-fetch.js'
import { type EventRow, materialize, seriesOf } from './instances.js'
import { detailedEvents } from './range-service.js'
import { type OccurrenceOverride, occurrenceOf } from './recurrence.js'
import { replanReminders } from './reminders.js'

/** Путь ленты ICS-подписки: токен в имени файла. */
export const FEED_PREFIX = '/api/v1/calendar-feeds'

/** Лента — события с экземплярами за последний год и дальше. */
const HISTORY = sql`interval '400 days'`
const MAX_FEED_EVENTS = 3000

const baseUrl = () => config().KCHS_BASE_URL.replace(/\/+$/, '')

function feedOf(row: typeof calendarFeeds.$inferSelect): CalendarFeed {
  return {
    id: row.id,
    calendarId: row.calendarId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

type ExportRow = EventRow & { title: string }

/** Событие ленты: детали — если видны владельцу ссылки, иначе только время. */
function icsEventOf(row: ExportRow, detailed: boolean): IcsEvent {
  const overrides = row.overrides as Record<string, OccurrenceOverride>
  const changes = Object.entries(overrides).flatMap(([key, change]) => {
    const recurrenceId = Date.parse(key)
    const occurrence = occurrenceOf(seriesOf(row), recurrenceId)
    if (!occurrence) return []
    return [
      {
        recurrenceId,
        startsAt: occurrence.startsAt,
        endsAt: occurrence.endsAt,
        startDate: occurrence.startDate,
        endDate: occurrence.endDate,
        ...(detailed && change.title !== undefined ? { summary: change.title } : {}),
        ...(detailed && change.location !== undefined ? { location: change.location } : {}),
        ...(detailed && change.description !== undefined
          ? { description: change.description }
          : {}),
      },
    ]
  })
  return {
    uid: row.uid,
    sequence: row.sequence,
    stamp: Date.now(),
    summary: row.title,
    description: detailed ? row.description : null,
    location: detailed ? row.location : null,
    allDay: row.allDay,
    startsAt: Date.parse(row.startsAt),
    endsAt: Date.parse(row.endsAt),
    startDate: row.startDate,
    endDate: row.endDate,
    timezone: row.timezone,
    rrule: row.rrule,
    exdates: row.exdates,
    changes,
    transparent: row.transparency === 'transparent',
    private: !detailed,
    url: detailed ? `${baseUrl()}/o/${row.id}` : null,
  }
}

export const IcsService = {
  /** Ссылка подписки: токен показывается один раз, в базе — только хэш. */
  async createFeed(tx: Executor, ctx: UserCtx, calendarId: string): Promise<CalendarFeedCreated> {
    await authorize(ctx, 'feed', calendarId)
    const calendar = await loadCalendar(tx, calendarId)
    if (!calendar) throw errors.notFound('Календарь')
    const token = randomToken(24)
    const [row] = await tx
      .insert(calendarFeeds)
      .values({ id: newId(), calendarId, userId: ctx.userId, tokenHash: hashToken(token) })
      .returning()
    if (!row) throw errors.internal('Ссылка не создана')
    await publishEvent(tx, ctx, {
      type: 'calendar.feed_created',
      object: {
        id: calendarId,
        type: 'calendar',
        spaceId: calendar.spaceId,
        title: calendar.title,
      },
      payload: { feedId: row.id },
    })
    return { ...feedOf(row), url: `${baseUrl()}${FEED_PREFIX}/${token}.ics` }
  },

  /** Мои ссылки подписки на календарь. */
  async listFeeds(ctx: UserCtx, calendarId: string): Promise<CalendarFeed[]> {
    await authorize(ctx, 'view', calendarId)
    const rows = await db()
      .select()
      .from(calendarFeeds)
      .where(
        and(
          eq(calendarFeeds.calendarId, calendarId),
          eq(calendarFeeds.userId, ctx.userId),
          isNull(calendarFeeds.revokedAt),
        ),
      )
      .orderBy(calendarFeeds.createdAt)
    return rows.map(feedOf)
  },

  /** Отзыв ссылки: свою — любой, чужую — управляющий календарём. */
  async revokeFeed(tx: Executor, ctx: UserCtx, calendarId: string, feedId: string): Promise<void> {
    const decision = await authorize(ctx, 'view', calendarId)
    const [row] = await tx
      .select()
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.id, feedId), eq(calendarFeeds.calendarId, calendarId)))
      .limit(1)
    if (!row || row.revokedAt) throw errors.notFound('Ссылка подписки')
    if (row.userId !== ctx.userId && !atLeast(decision.level, 'manage')) {
      throw errors.forbidden('Отозвать чужую ссылку может управляющий календарём')
    }
    await tx
      .update(calendarFeeds)
      .set({ revokedAt: sql`now()` })
      .where(eq(calendarFeeds.id, feedId))
    const calendar = await loadCalendar(tx, calendarId)
    await publishEvent(tx, ctx, {
      type: 'calendar.feed_revoked',
      object: {
        id: calendarId,
        type: 'calendar',
        spaceId: calendar?.spaceId ?? null,
        title: calendar?.title ?? '',
      },
      payload: { feedId },
    })
  },

  /**
   * Лента по токену (публичный адрес): права — того, кто выпустил ссылку, в
   * момент запроса. Отозванная ссылка, заблокированный владелец или потерянный
   * доступ — `null` (404 без подробностей).
   */
  async feedByToken(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null
    const [row] = await db()
      .select()
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.tokenHash, hashToken(token)), isNull(calendarFeeds.revokedAt)))
      .limit(1)
    if (!row) return null
    const owner = (await directory().refs([row.userId])).get(row.userId)
    if (!owner || (owner.status && owner.status !== 'active')) return null
    const ctx = await buildUserCtxFor(row.userId)
    if (!ctx) return null
    const decision = await authorize(ctx, 'view', row.calendarId, { soft: true })
    if (!decision.allowed) return null
    const calendar = await loadCalendar(db(), row.calendarId)
    if (!calendar) return null
    const text = await IcsService.exportCalendar(ctx, calendar, decision.level)
    if (!row.lastUsedAt || Date.parse(row.lastUsedAt) < Date.now() - 3_600_000) {
      await db()
        .update(calendarFeeds)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(calendarFeeds.id, row.id))
    }
    return text
  },

  /**
   * Календарь в iCalendar: события календаря (у личного — и приглашения
   * владельца), чужие закрытые — «занято».
   */
  async exportCalendar(ctx: UserCtx, calendar: CalendarRow, level: Level): Promise<string> {
    const me = principalUser(ctx)
    const personal = calendar.kind === 'personal' && calendar.ownerId === me
    const recent = sql`EXISTS (SELECT 1 FROM ${eventInstances} i
      WHERE i.event_id = ${events.id} AND i.ends_at > now() - ${HISTORY})`
    const invited = sql`${events.id} IN (SELECT a.event_id FROM ${eventAttendees} a
      WHERE a.user_id = ${me} AND a.role = 'attendee' AND a.status <> 'declined')`
    const rows = await db()
      .select({ event: events, title: objects.title })
      .from(events)
      .innerJoin(objects, eq(objects.id, events.id))
      .where(
        and(
          sql`${objects.deletedAt} IS NULL`,
          personal
            ? sql`(${events.calendarId} = ${calendar.id} OR ${invited})`
            : eq(events.calendarId, calendar.id),
          recent,
        ),
      )
      .limit(MAX_FEED_EVENTS)
    const exported: ExportRow[] = rows.map((row) => ({ ...row.event, title: row.title }))
    const detailed = await detailedEvents(
      ctx,
      exported.map((row) => ({
        eventId: row.id,
        visibility: row.visibility,
        calendarId: row.calendarId,
      })),
      atLeast(level, 'edit') ? new Set([calendar.id]) : new Set(),
    )
    const t = createTranslator(ctx.locale as Locale)
    return buildCalendar(
      calendar.title,
      exported.map((row) => icsEventOf(row, detailed.has(row.id))),
      { busyLabel: t('calendar.busy') },
    )
  },

  /** Импорт `.ics` в календарь: новые события, правка ранее загруженных по UID. */
  async importInto(ctx: UserCtx, calendarId: string, text: string): Promise<CalendarImportResult> {
    await authorize(ctx, 'import', calendarId)
    const calendar = await loadCalendar(db(), calendarId)
    if (!calendar) throw errors.notFound('Календарь')
    if (calendar.kind === 'resource' || calendar.kind === 'subscription') {
      throw errors.validation('В этот календарь нельзя загружать события')
    }
    const parsed = parseCalendar(text, calendar.timezone)
    if (parsed.events.length === 0 && parsed.errors.length > 0) {
      throw errors.validation(parsed.errors[0]?.message ?? 'Файл не является календарём')
    }
    const organizerId =
      calendar.kind === 'personal' && calendar.ownerId ? calendar.ownerId : principalUser(ctx)
    const result = await applyParsed(ctx, calendar, parsed.events, {
      source: 'import',
      organizerId,
      removeMissing: false,
    })
    await db().transaction((tx) =>
      publishEvent(tx, ctx, {
        type: 'calendar.imported',
        object: {
          id: calendar.id,
          type: 'calendar',
          spaceId: calendar.spaceId,
          title: calendar.title,
        },
        payload: { source: 'file', ...result.counts },
      }),
    )
    return {
      created: result.counts.created,
      updated: result.counts.updated,
      skipped: result.counts.skipped,
      errors: [...parsed.errors, ...result.errors].slice(0, 50),
    }
  },

  /**
   * Синхронизация подписки (задание `calendar.sync`): канал читается заново,
   * события сверяются по UID — новые, изменённые и исчезнувшие.
   */
  async syncSubscription(calendarId: string): Promise<void> {
    const ctx = systemCtx('calendar.sync')
    const [source] = await db()
      .select({ sourceEnc: calendars.sourceEnc, kind: calendars.kind })
      .from(calendars)
      .innerJoin(objects, eq(objects.id, calendars.id))
      .where(and(eq(calendars.id, calendarId), sql`${objects.deletedAt} IS NULL`))
      .limit(1)
    const calendar = await loadCalendar(db(), calendarId)
    if (!source || !calendar || source.kind !== 'subscription' || !source.sourceEnc) return
    const view = {
      id: calendar.id,
      type: 'calendar',
      spaceId: calendar.spaceId,
      title: calendar.title,
    }
    try {
      const text = await fetchIcs(decryptSecret(source.sourceEnc))
      const parsed = parseCalendar(text, calendar.timezone)
      if (parsed.events.length === 0 && parsed.errors.length > 0) {
        throw errors.dependencyFailed(parsed.errors[0]?.message ?? 'Ответ — не календарь')
      }
      const result = await applyParsed(ctx, calendar, parsed.events, {
        source: 'subscription',
        organizerId: null,
        removeMissing: true,
      })
      await db().transaction(async (tx) => {
        await tx
          .update(calendars)
          .set({ syncStatus: 'ok', syncedAt: sql`now()`, syncError: null })
          .where(eq(calendars.id, calendarId))
        await publishEvent(tx, ctx, {
          type: 'calendar.imported',
          object: view,
          payload: { source: 'subscription', ...result.counts },
        })
      })
    } catch (error) {
      const message = isAppError(error) ? error.message : 'Календарь не прочитан'
      logger().warn({ err: error, calendarId }, 'подписка на календарь не синхронизирована')
      await db().transaction(async (tx) => {
        await tx
          .update(calendars)
          .set({ syncStatus: 'error', syncedAt: sql`now()`, syncError: message })
          .where(eq(calendars.id, calendarId))
        await publishEvent(tx, ctx, {
          type: 'calendar.sync_failed',
          object: view,
          payload: { error: message },
        })
      })
    }
  },
}

interface ApplyOptions {
  source: 'import' | 'subscription'
  organizerId: string | null
  removeMissing: boolean
}

interface ApplyResult {
  counts: { created: number; updated: number; removed: number; skipped: number }
  errors: Array<{ uid: string | null; message: string }>
}

/** Сравниваемые поля: подписка не переписывает неизменившиеся события. */
function sameContent(row: ExportRow, event: ParsedEvent, visibility: string): boolean {
  return (
    row.title === event.summary &&
    row.description === event.description &&
    row.location === event.location &&
    Date.parse(row.startsAt) === event.startsAt &&
    Date.parse(row.endsAt) === event.endsAt &&
    row.startDate === event.startDate &&
    row.endDate === event.endDate &&
    row.timezone === event.timezone &&
    row.rrule === event.rrule &&
    JSON.stringify([...row.exdates].sort()) === JSON.stringify([...event.exdates].sort()) &&
    JSON.stringify(row.overrides) === JSON.stringify(event.overrides) &&
    row.transparency === (event.transparent ? 'transparent' : 'opaque') &&
    row.visibility === visibility
  )
}

async function applyParsed(
  ctx: Ctx,
  calendar: CalendarRow,
  parsed: ParsedEvent[],
  options: ApplyOptions,
): Promise<ApplyResult> {
  const existing = await db()
    .select({ event: events, title: objects.title })
    .from(events)
    .innerJoin(objects, eq(objects.id, events.id))
    .where(and(eq(events.calendarId, calendar.id), sql`${objects.deletedAt} IS NULL`))
  const byUid = new Map(existing.map((row) => [row.event.uid, { ...row.event, title: row.title }]))
  const counts = { created: 0, updated: 0, removed: 0, skipped: 0 }
  const problems: ApplyResult['errors'] = []
  const seen = new Set<string>()

  for (const event of parsed) {
    seen.add(event.uid)
    const current = byUid.get(event.uid)
    // Подписка показывает события канала как есть; личное из файла — личное
    const visibility = options.source === 'subscription' || !event.private ? 'public' : 'private'
    try {
      if (event.cancelled) {
        if (current && current.source !== 'local') {
          await db().transaction((tx) => ObjectService.trash(tx, ctx, current.id))
          counts.removed += 1
        } else {
          counts.skipped += 1
        }
        continue
      }
      if (current) {
        // События, созданные в kchs, импорт не переписывает (повторная загрузка своей ленты)
        if (current.source === 'local' || sameContent(current, event, visibility)) {
          counts.skipped += 1
          continue
        }
        await db().transaction(async (tx) => {
          const [row] = await tx
            .update(events)
            .set({
              startsAt: new Date(event.startsAt).toISOString(),
              endsAt: new Date(event.endsAt).toISOString(),
              allDay: event.allDay,
              startDate: event.startDate,
              endDate: event.endDate,
              timezone: event.timezone,
              rrule: event.rrule,
              exdates: event.exdates,
              overrides: event.overrides,
              location: event.location,
              description: event.description,
              transparency: event.transparent ? 'transparent' : 'opaque',
              sequence: event.sequence,
            })
            .where(eq(events.id, current.id))
            .returning()
          if (!row) return
          if (current.title !== event.summary) {
            await ObjectService.update(tx, ctx, current.id, { title: event.summary })
          }
          await materialize(tx, row)
          await replanReminders(tx, [row.id])
          await publishEvent(tx, ctx, {
            type: 'event.updated',
            object: { id: row.id, type: 'event', spaceId: calendar.spaceId, title: event.summary },
            payload: {
              calendarId: calendar.id,
              changed: ['import'],
              scope: 'series',
              recurrenceId: null,
              timeChanged: Date.parse(current.startsAt) !== event.startsAt,
              startsAt: row.startsAt,
            },
          })
        })
        counts.updated += 1
        continue
      }
      await db().transaction(async (tx) => {
        const row = await insertEvent(tx, ctx, {
          calendar,
          title: event.summary,
          description: event.description,
          location: event.location,
          time: {
            allDay: event.allDay,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            startDate: event.startDate,
            endDate: event.endDate,
            timezone: event.timezone,
          },
          rrule: event.rrule,
          exdates: event.exdates,
          overrides: event.overrides,
          visibility,
          transparency: event.transparent ? 'transparent' : 'opaque',
          color: null,
          reminders: [],
          ownerId: options.organizerId ?? calendar.ownerId,
          organizerId: options.organizerId,
          attendees: [],
          resourceIds: [],
          linkedObjectIds: [],
          uid: event.uid,
          sequence: event.sequence,
          source: options.source,
        })
        await publishEvent(tx, ctx, {
          type: 'event.created',
          object: { id: row.id, type: 'event', spaceId: calendar.spaceId, title: event.summary },
          payload: {
            calendarId: calendar.id,
            startsAt: row.startsAt,
            allDay: row.allDay,
            recurring: Boolean(row.rrule),
          },
        })
      })
      counts.created += 1
    } catch (error) {
      problems.push({
        uid: event.uid,
        message: isAppError(error) ? error.message : 'Событие не загружено',
      })
      counts.skipped += 1
    }
  }

  if (options.removeMissing) {
    const gone = existing
      .map((row) => row.event)
      .filter((row) => row.source === options.source && !seen.has(row.uid))
    for (const row of gone) {
      // Исчезнувшее из канала событие — зеркало, не документ пользователя: удаляется насовсем
      await db().transaction((tx) => ObjectService.purge(tx, ctx, row.id))
      counts.removed += 1
    }
  }
  return { counts, errors: problems }
}

/** Подписки, которые пора перечитать (задание раз в полчаса). */
export async function subscriptionsDue(): Promise<string[]> {
  const rows = await db()
    .select({ id: calendars.id })
    .from(calendars)
    .innerJoin(objects, eq(objects.id, calendars.id))
    .where(
      and(
        eq(calendars.kind, 'subscription'),
        sql`${objects.deletedAt} IS NULL`,
        sql`(${calendars.syncedAt} IS NULL OR ${calendars.syncedAt} < now() - interval '25 minutes')`,
      ),
    )
    .limit(500)
  return rows.map((row) => row.id)
}
