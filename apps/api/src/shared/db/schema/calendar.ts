import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbArray, jsonbObject, tsCol } from './_shared.js'
import { bytea, users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Календари и события (05-data-model.md, 12-calendar-notifications-home.md §1,
 * ADR-0081). Название, пространство, владелец и жизненный цикл — в реестре
 * `objects`; здесь — то, что знает только модуль календаря.
 */

/** Сведения ресурса (переговорная, техника). */
export interface ResourceInfoValue {
  kind: string
  location: string | null
  capacity: number | null
}

/** Напоминание: за сколько минут до начала и в какие каналы. */
export interface ReminderValue {
  minutes: number
  channels: string[]
}

/** Правка одного экземпляра серии: время, название, место, описание. */
export interface OccurrenceOverrideValue {
  startsAt?: string
  endsAt?: string
  startDate?: string
  endDate?: string
  title?: string
  location?: string | null
  description?: string | null
}

/** Календарь — объект реестра типа `calendar`. */
export const calendars = pgTable(
  'calendars',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    color: text('color').notNull().default('blue'),
    timezone: text('timezone').notNull().default('Asia/Dushanbe'),
    description: text('description'),
    /**
     * Автоматический календарь не дублируется: `personal:<userId>`,
     * `space:<spaceId>`, `project:<projectId>`.
     */
    systemKey: text('system_key'),
    /** Проект проектного календаря — объект модуля задач, без внешнего ключа. */
    projectId: uuid('project_id'),
    resource: jsonb('resource').$type<ResourceInfoValue | null>(),
    /** Адрес канала подписки — зашифрован: в нём бывает секретный токен. */
    sourceEnc: bytea('source_enc'),
    sourceHost: text('source_host'),
    syncStatus: text('sync_status'),
    syncedAt: tsCol('synced_at'),
    syncError: text('sync_error'),
    settings: jsonbObject('settings'),
  },
  (t) => [
    uniqueIndex('calendars_system_key_uq').on(t.systemKey),
    index('calendars_owner_idx').on(t.ownerId, t.kind),
    index('calendars_kind_idx').on(t.kind),
  ],
)

/**
 * Событие — объект реестра типа `event`, дочерний объект календаря. Время
 * первого экземпляра, правило RRULE и исключения; экземпляры — в
 * `event_instances`. У события на весь день — даты (`end_date` не включается).
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    organizerId: uuid('organizer_id').references(() => users.id, { onDelete: 'set null' }),
    startsAt: tsCol('starts_at').notNull(),
    endsAt: tsCol('ends_at').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    startDate: date('start_date'),
    endDate: date('end_date'),
    timezone: text('timezone').notNull(),
    rrule: text('rrule'),
    /** Исходные начала отменённых экземпляров (ISO). */
    exdates: jsonbArray<string>('exdates'),
    /** Правки отдельных экземпляров: исходное начало (ISO) → изменения. */
    overrides: jsonbObject<Record<string, OccurrenceOverrideValue>>('overrides'),
    /** До какого момента материализованы экземпляры бесконечной серии. */
    materializedUntil: tsCol('materialized_until'),
    location: text('location'),
    description: text('description'),
    /** Встреча LiveKit — фаза 4 (11-communications-meetings.md §3). */
    meetingId: uuid('meeting_id'),
    visibility: text('visibility').notNull().default('public'),
    /** `opaque` — занят, `transparent` — свободен (RFC 5545 TRANSP). */
    transparency: text('transparency').notNull().default('opaque'),
    reminders: jsonbArray<ReminderValue>('reminders'),
    linkedObjectIds: uuid('linked_object_ids').array().notNull().default(sql`'{}'::uuid[]`),
    color: text('color'),
    /** UID iCalendar: стабилен при экспорте, по нему сверяется импорт. */
    uid: text('uid').notNull(),
    sequence: integer('sequence').notNull().default(0),
    source: text('source').notNull().default('local'),
    /** Серия, от которой отделена эта («это и следующие»). */
    seriesId: uuid('series_id'),
  },
  (t) => [
    index('events_calendar_idx').on(t.calendarId),
    uniqueIndex('events_calendar_uid_uq').on(t.calendarId, t.uid),
    index('events_rrule_idx').on(t.materializedUntil).where(sql`${t.rrule} is not null`),
  ],
)

/**
 * Участники с ответами. Организатор — тоже строка (роль `organizer`): так
 * занятость, напоминания и доступ считаются одинаково для всех участников.
 */
export const eventAttendees = pgTable(
  'event_attendees',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('attendee'),
    optional: boolean('optional').notNull().default(false),
    status: text('status').notNull().default('needs_action'),
    comment: text('comment'),
    proposal: jsonb('proposal').$type<{
      startsAt: string
      endsAt: string
      recurrenceId: string | null
    } | null>(),
    respondedAt: tsCol('responded_at'),
    /** Свои напоминания участника; `null` — напоминания события. */
    reminders: jsonb('reminders').$type<ReminderValue[] | null>(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index('event_attendees_user_idx').on(t.userId, t.status),
  ],
)

/** Забронированные ресурсы события. */
export const eventResources = pgTable(
  'event_resources',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('accepted'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.resourceId] }),
    index('event_resources_resource_idx').on(t.resourceId),
  ],
)

/**
 * Материализованные экземпляры (05-data-model.md): быстрые выборки диапазона,
 * занятости и напоминаний. Пересчитываются при правке серии; бесконечные
 * серии — на два года вперёд, горизонт продлевает задание.
 */
export const eventInstances = pgTable(
  'event_instances',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    /** Исходное начало экземпляра (RECURRENCE-ID); у одиночного — его начало. */
    recurrenceId: tsCol('recurrence_id').notNull(),
    startsAt: tsCol('starts_at').notNull(),
    endsAt: tsCol('ends_at').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    startDate: date('start_date'),
    endDate: date('end_date'),
    overridden: boolean('overridden').notNull().default(false),
  },
  (t) => [
    uniqueIndex('event_instances_event_recurrence_uq').on(t.eventId, t.recurrenceId),
    index('event_instances_event_idx').on(t.eventId, t.startsAt),
    index('event_instances_calendar_idx').on(t.calendarId, t.startsAt),
    index('event_instances_period_idx').using(
      'gist',
      sql`tstzrange(${t.startsAt}, ${t.endsAt}, '[)')`,
    ),
  ],
)

/**
 * Очередь напоминаний на ближайшие сутки: строка — экземпляр × участник ×
 * напоминание. Отметка `sent_at` ставится в той же транзакции, что и событие
 * `event.reminder`, — перезапуск worker не повторяет напоминание.
 */
export const eventReminders = pgTable(
  'event_reminders',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Исходное начало экземпляра. */
    recurrenceId: tsCol('recurrence_id').notNull(),
    startsAt: tsCol('starts_at').notNull(),
    minutes: integer('minutes').notNull(),
    channels: text('channels').array().notNull(),
    fireAt: tsCol('fire_at').notNull(),
    sentAt: tsCol('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // Перенесённый экземпляр получает напоминание заново: начало — часть ключа
    uniqueIndex('event_reminders_uq').on(
      t.eventId,
      t.userId,
      t.recurrenceId,
      t.startsAt,
      t.minutes,
    ),
    index('event_reminders_due_idx').on(t.fireAt).where(sql`${t.sentAt} is null`),
  ],
)

/** Ссылки ICS-подписки: токен хранится хэшем, ссылку можно отозвать. */
export const calendarFeeds = pgTable(
  'calendar_feeds',
  {
    id: uuid('id').primaryKey(),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    /** Кто выпустил ссылку: лента строится с его правами. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    lastUsedAt: tsCol('last_used_at'),
    revokedAt: tsCol('revoked_at'),
  },
  (t) => [
    uniqueIndex('calendar_feeds_token_uq').on(t.tokenHash),
    index('calendar_feeds_calendar_idx').on(t.calendarId, t.userId),
  ],
)
