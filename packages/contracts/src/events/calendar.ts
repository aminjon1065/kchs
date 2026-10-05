import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Календарь» (12-calendar-notifications-home.md §1). Домены `calendar`, `event` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const CALENDAR_EVENTS = {
  // ── calendar (12-calendar-notifications-home.md §1, ADR-0081) ───────────────
  'calendar.created': z.object({ kind: z.string() }),
  /** Название, цвет, пояс, описание или сведения ресурса. */
  'calendar.updated': z.object({ changed: z.array(z.string()) }),
  /** События загружены из файла `.ics` или из канала подписки. */
  'calendar.imported': z.object({
    source: z.enum(['file', 'subscription']),
    created: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
    skipped: z.number().int(),
  }),
  /** Канал подписки не прочитан: адрес недоступен или ответ — не календарь. */
  'calendar.sync_failed': z.object({ error: z.string() }),
  'calendar.feed_created': z.object({ feedId: Uuid }),
  'calendar.feed_revoked': z.object({ feedId: Uuid }),
  /** Объект события — `event`; время первого экземпляра и правило повтора. */
  'event.created': z.object({
    calendarId: Uuid,
    startsAt: z.string(),
    allDay: z.boolean(),
    recurring: z.boolean(),
  }),
  /**
   * Правка: поля, область (`occurrence` — один экземпляр, `following` — серия
   * разделена, `series` — вся серия) и признак переноса времени.
   */
  'event.updated': z.object({
    calendarId: Uuid,
    changed: z.array(z.string()),
    scope: z.enum(['occurrence', 'following', 'series']),
    recurrenceId: z.string().nullable(),
    timeChanged: z.boolean(),
    startsAt: z.string(),
  }),
  /** Отмена события, экземпляра или «этого и следующих». */
  'event.cancelled': z.object({
    calendarId: Uuid,
    scope: z.enum(['occurrence', 'following', 'series']),
    recurrenceId: z.string().nullable(),
  }),
  'event.invited': z.object({ userIds: z.array(Uuid) }),
  'event.uninvited': z.object({ userIds: z.array(Uuid) }),
  'event.responded': z.object({
    userId: Uuid,
    status: z.enum(['accepted', 'tentative', 'declined']),
    proposed: z.boolean(),
  }),
  /** Напоминание экземпляра наступило: доставка — подписчиком через уведомления ядра. */
  'event.reminder': z.object({
    userId: Uuid,
    occurrenceStart: z.string(),
    minutes: z.number().int(),
    channels: z.array(z.string()),
  }),
} as const satisfies Record<string, z.ZodType>
