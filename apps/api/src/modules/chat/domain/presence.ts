import type {
  PresenceChoice,
  PresenceState,
  PresenceStatus,
  PresenceUpdateInput,
  QuietHours,
} from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { emitToUser } from '~/kernel/realtime/gateway.js'
import { UserService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { userPresence } from '~/shared/db/schema/index.js'

/** Дольше этого без отметки активности — «отошёл»; вдвое дольше — «не в сети». */
const AWAY_AFTER_MINUTES = 5
const OFFLINE_AFTER_MINUTES = 15

const DEFAULT_QUIET: QuietHours = { enabled: false, from: '21:00', to: '08:00' }

interface PresenceRow {
  userId: string
  status: string
  statusUntil: string | null
  quietHours: { enabled?: boolean; from?: string; to?: string }
  inMeeting: boolean
  lastSeenAt: string | null
}

function minutesOf(value: string): number {
  const [h = '0', m = '0'] = value.split(':')
  return Number(h) * 60 + Number(m)
}

/** Время в поясе пользователя внутри тихих часов (интервал может пересекать полночь). */
export function inQuietHours(quiet: QuietHours, timezone: string, at = new Date()): boolean {
  if (!quiet.enabled) return false
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
  const now = minutesOf(local)
  const from = minutesOf(quiet.from)
  const to = minutesOf(quiet.to)
  return from <= to ? now >= from && now < to : now >= from || now < to
}

function quietOf(row: PresenceRow | undefined): QuietHours {
  return {
    enabled: row?.quietHours?.enabled ?? DEFAULT_QUIET.enabled,
    from: row?.quietHours?.from ?? DEFAULT_QUIET.from,
    to: row?.quietHours?.to ?? DEFAULT_QUIET.to,
  }
}

function chosenOf(row: PresenceRow | undefined): PresenceChoice {
  if (!row) return 'online'
  const expired = row.statusUntil !== null && Date.parse(row.statusUntil) <= Date.now()
  if (expired) return 'online'
  return row.status === 'away' || row.status === 'dnd' ? row.status : 'online'
}

/**
 * Действующий статус: «на встрече» — поверх всего (её выставляет подписчик
 * `meeting.participant_joined`), затем выбранный «не беспокоить» и тихие часы,
 * затем давность последней активности.
 */
function effective(
  row: PresenceRow | undefined,
  quiet: QuietHours,
  timezone: string,
): PresenceStatus {
  if (row?.inMeeting) return 'in_meeting'
  const chosen = chosenOf(row)
  if (chosen === 'dnd' || inQuietHours(quiet, timezone)) return 'dnd'
  const seen = row?.lastSeenAt ? Date.parse(row.lastSeenAt) : 0
  const idleMinutes = (Date.now() - seen) / 60_000
  if (!row?.lastSeenAt || idleMinutes > OFFLINE_AFTER_MINUTES) return 'offline'
  if (chosen === 'away' || idleMinutes > AWAY_AFTER_MINUTES) return 'away'
  return 'online'
}

function toState(userId: string, row: PresenceRow | undefined, timezone: string): PresenceState {
  const quiet = quietOf(row)
  return {
    userId,
    status: effective(row, quiet, timezone),
    chosen: chosenOf(row),
    until: row?.statusUntil ?? null,
    inMeeting: row?.inMeeting ?? false,
    quietHours: quiet,
    lastSeenAt: row?.lastSeenAt ?? null,
  }
}

async function load(userIds: string[]): Promise<Map<string, PresenceRow>> {
  if (userIds.length === 0) return new Map()
  const rows = await db().select().from(userPresence).where(inArray(userPresence.userId, userIds))
  return new Map(rows.map((row) => [row.userId, row as PresenceRow]))
}

/**
 * Присутствие и статусы (11-communications-meetings.md §1, ADR-0090): выбранный
 * статус, тихие часы и «не беспокоить» живут здесь же — их читает подписчик
 * уведомлений чата, решая, каким каналом звать человека.
 */
export const PresenceService = {
  async get(userId: string, timezone: string): Promise<PresenceState> {
    const rows = await load([userId])
    return toState(userId, rows.get(userId), timezone)
  },

  async many(userIds: string[], timezone: string): Promise<PresenceState[]> {
    const rows = await load(userIds)
    return userIds.map((userId) => toState(userId, rows.get(userId), timezone))
  },

  /** Отметка активности: экран чатов шлёт её вместе с запросом списка бесед. */
  async touch(userId: string): Promise<void> {
    await db()
      .insert(userPresence)
      .values({ userId, lastSeenAt: sql`now()` })
      .onConflictDoUpdate({
        target: userPresence.userId,
        set: { lastSeenAt: sql`now()`, updatedAt: sql`now()` },
      })
  },

  async update(ctx: UserCtx, input: PresenceUpdateInput): Promise<PresenceState> {
    const userId = ctx.userId
    const before = await PresenceService.get(userId, ctx.timezone)
    // Срок статуса считаем здесь: значение одинаково и для вставки, и для обновления
    const until =
      input.untilMinutes && input.untilMinutes > 0
        ? new Date(Date.now() + input.untilMinutes * 60_000).toISOString()
        : null
    const patch = {
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      ...(input.status ? { status: input.status, statusUntil: until } : {}),
      ...(input.quietHours ? { quietHours: input.quietHours } : {}),
    }

    await db()
      .insert(userPresence)
      .values({
        userId,
        status: input.status ?? 'online',
        statusUntil: until,
        ...(input.quietHours ? { quietHours: input.quietHours } : {}),
        lastSeenAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({ target: userPresence.userId, set: patch })

    const after = await PresenceService.get(userId, ctx.timezone)
    if (after.status !== before.status) {
      await db().transaction((tx) =>
        publishEvent(tx, ctx, {
          type: 'chat.presence_changed',
          object: null,
          payload: { userId, status: after.status, from: before.status },
        }),
      )
    }
    return after
  },

  /** Вход в комнату встречи и выход из неё — статус «на встрече» (ADR-0089, ADR-0090). */
  async setInMeeting(userId: string, inMeeting: boolean): Promise<void> {
    const [row] = await db()
      .insert(userPresence)
      .values({ userId, inMeeting, lastSeenAt: sql`now()` })
      .onConflictDoUpdate({
        target: userPresence.userId,
        set: { inMeeting, updatedAt: sql`now()` },
      })
      .returning({ userId: userPresence.userId })
    if (!row) return
    await db().transaction((tx) =>
      publishEvent(tx, systemCtx('chat.presence'), {
        type: 'chat.presence_changed',
        object: null,
        payload: {
          userId,
          status: inMeeting ? 'in_meeting' : 'online',
          from: inMeeting ? 'online' : 'in_meeting',
        },
      }),
    )
    emitToUser(userId, 'presence.changed', { userId, inMeeting })
  },

  /**
   * Звать ли человека во внешние каналы: «не беспокоить», тихие часы и
   * встреча оставляют только значок в приложении.
   */
  async quiet(userId: string, timezone: string): Promise<boolean> {
    const state = await PresenceService.get(userId, timezone)
    return state.status === 'dnd' || state.status === 'in_meeting'
  },

  /**
   * Кто сейчас «в тишине» (ADR-0140): выбрал «не беспокоить», у него тихие часы по его
   * поясу или идёт встреча. Ядро уведомлений глушит этим людям внешние каналы у всего,
   * кроме срочного. Пояс читается только у тех, у кого тихие часы включены.
   */
  async quietUsers(userIds: readonly string[]): Promise<Set<string>> {
    const rows = await load([...new Set(userIds)])
    const quiet = new Set<string>()
    for (const [userId, row] of rows) {
      if (row.inMeeting || chosenOf(row) === 'dnd') {
        quiet.add(userId)
        continue
      }
      const hours = quietOf(row)
      if (!hours.enabled) continue
      const profile = await UserService.profile(userId)
      if (inQuietHours(hours, profile?.timezone ?? config().TZ)) quiet.add(userId)
    }
    return quiet
  },

  /** Сброс «на встрече» при старте воркера: комнаты после перезапуска пусты. */
  async clearMeetings(): Promise<void> {
    await db()
      .update(userPresence)
      .set({ inMeeting: false, updatedAt: sql`now()` })
      .where(eq(userPresence.inMeeting, true))
  },
}
