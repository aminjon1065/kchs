import { z } from 'zod'
import { Level } from '../access/levels.js'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Календари (12-calendar-notifications-home.md §1, ADR-0081): объекты реестра
 * типа `calendar`. Личный создаётся автоматически, календарь подразделения —
 * для каждого пространства подразделения; проектный — дочерний объект проекта;
 * ресурсный — переговорная или техника (занятость ресурса); подписка —
 * внешний ICS-канал, только чтение.
 */
export const CALENDAR_KINDS = ['personal', 'team', 'project', 'resource', 'subscription'] as const
export const CalendarKind = z.enum(CALENDAR_KINDS)
export type CalendarKind = z.infer<typeof CalendarKind>

/** Виды, которые создаются вручную (личный и подразделения — автоматически). */
export const CREATABLE_CALENDAR_KINDS = ['team', 'project', 'resource', 'subscription'] as const
export const CreatableCalendarKind = z.enum(CREATABLE_CALENDAR_KINDS)

/**
 * Цвет календаря или события — ключ палитры дизайн-системы (оттенки графиков
 * `chart-1…10`), а не произвольное значение: цвета остаются в токенах и в
 * обеих темах.
 */
export const CALENDAR_COLORS = [
  'blue',
  'orange',
  'green',
  'red',
  'purple',
  'teal',
  'gold',
  'pink',
  'slate',
  'brown',
] as const
export const CalendarColor = z.enum(CALENDAR_COLORS)
export type CalendarColor = z.infer<typeof CalendarColor>

/** Часовой пояс IANA, известный среде выполнения (`Asia/Dushanbe`). */
export const TimeZoneName = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'неизвестный часовой пояс')

/** Время суток `чч:мм`. */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'время в формате чч:мм')

export const RESOURCE_KINDS = ['room', 'equipment', 'vehicle', 'other'] as const
export const ResourceKind = z.enum(RESOURCE_KINDS)
export type ResourceKind = z.infer<typeof ResourceKind>

/** Сведения ресурса: что это, где, сколько мест. */
export const ResourceInfo = z.object({
  kind: ResourceKind.default('room'),
  location: z.string().trim().max(300).nullable().default(null),
  capacity: z.number().int().min(1).max(10_000).nullable().default(null),
})
export type ResourceInfo = z.infer<typeof ResourceInfo>

export const CalendarSyncStatus = z.enum(['pending', 'ok', 'error'])
export type CalendarSyncStatus = z.infer<typeof CalendarSyncStatus>

/** Подписка на внешний ICS: адрес показывается без пути (в нём бывает секрет). */
export const CalendarSubscriptionInfo = z.object({
  host: z.string(),
  status: CalendarSyncStatus,
  syncedAt: Timestamp.nullable(),
  error: z.string().nullable(),
})

/** Что пользователь может сделать с календарём (кнопки и пункты меню). */
export const CalendarPermissions = z.object({
  /** Создавать и править события календаря. */
  edit: z.boolean(),
  /** Настройки, доступ, удаление. */
  manage: z.boolean(),
  /** Бронировать ресурс (у ресурсов). */
  book: z.boolean(),
  /** Выпускать ссылку ICS-подписки. */
  feed: z.boolean(),
})
export type CalendarPermissions = z.infer<typeof CalendarPermissions>

export const CalendarRecord = z.object({
  id: Uuid,
  kind: CalendarKind,
  title: z.string(),
  description: z.string().nullable(),
  color: CalendarColor,
  timezone: z.string(),
  spaceId: Uuid.nullable(),
  spaceName: z.string().nullable(),
  owner: UserRef.nullable(),
  /** Проект проектного календаря. */
  projectId: Uuid.nullable(),
  resource: ResourceInfo.nullable(),
  subscription: CalendarSubscriptionInfo.nullable(),
  /** Мой личный календарь. */
  mine: z.boolean(),
  /** Календарь добавлен пользователем в свой список вручную. */
  added: z.boolean(),
  /** Отмечен в левой колонке: его события показываются. */
  shown: z.boolean(),
  level: Level,
  can: CalendarPermissions,
  updatedAt: Timestamp,
})
export type CalendarRecord = z.infer<typeof CalendarRecord>

export const CalendarList = z.object({ items: z.array(CalendarRecord) })
export type CalendarList = z.infer<typeof CalendarList>

export const CalendarListQuery = z.object({
  /** `mine` — мой список (по умолчанию), `available` — все доступные для добавления. */
  scope: z.enum(['mine', 'available']).default('mine'),
  kind: CalendarKind.optional(),
  q: z.string().trim().max(200).optional(),
})
export type CalendarListQuery = z.infer<typeof CalendarListQuery>

export const CalendarCreateInput = z
  .object({
    kind: CreatableCalendarKind,
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    color: CalendarColor.optional(),
    timezone: TimeZoneName.optional(),
    /** Пространство командного и ресурсного календаря. */
    spaceId: Uuid.optional(),
    /** Проект проектного календаря. */
    projectId: Uuid.optional(),
    resource: ResourceInfo.optional(),
    /** Адрес ICS-канала подписки: http(s) или webcal. */
    url: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, context) => {
    const need = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message })
    if (value.kind === 'team' && !value.spaceId) need('spaceId', 'укажите пространство')
    if (value.kind === 'team' && !value.title) need('title', 'укажите название')
    if (value.kind === 'project' && !value.projectId) need('projectId', 'укажите проект')
    if (value.kind === 'resource' && !value.title) need('title', 'укажите название ресурса')
    if (value.kind === 'subscription' && !value.url) need('url', 'укажите адрес календаря')
  })
export type CalendarCreateInput = z.infer<typeof CalendarCreateInput>

export const CalendarUpdateInput = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  color: CalendarColor.optional(),
  timezone: TimeZoneName.optional(),
  resource: ResourceInfo.optional(),
})
export type CalendarUpdateInput = z.infer<typeof CalendarUpdateInput>

// ─── Подписка ICS (экспорт) ─────────────────────────────────────────────────

/**
 * Ссылка ICS-подписки на календарь: секретный токен в адресе, отзывается.
 * Лента строится с правами выпустившего ссылку в момент запроса.
 */
export const CalendarFeed = z.object({
  id: Uuid,
  calendarId: Uuid,
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
})
export type CalendarFeed = z.infer<typeof CalendarFeed>

/** Выпущенная ссылка: адрес показывается один раз — токен не хранится открыто. */
export const CalendarFeedCreated = CalendarFeed.extend({ url: z.string() })
export type CalendarFeedCreated = z.infer<typeof CalendarFeedCreated>

// ─── Импорт ICS ───────────────────────────────────────────────────────────

export const CalendarImportInput = z.object({
  /** Текст файла `.ics` (iCalendar, RFC 5545). */
  ics: z.string().min(1).max(5_000_000),
})
export type CalendarImportInput = z.infer<typeof CalendarImportInput>

export const CalendarImportResult = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ uid: z.string().nullable(), message: z.string() })),
})
export type CalendarImportResult = z.infer<typeof CalendarImportResult>

// ─── Настройки пользователя ───────────────────────────────────────────────

/** Каналы напоминания; `push` — уведомление на устройство (ADR-0162). */
export const REMINDER_CHANNELS = ['app', 'email', 'telegram', 'push'] as const
export const ReminderChannel = z.enum(REMINDER_CHANNELS)
export type ReminderChannel = z.infer<typeof ReminderChannel>

/** Напоминание: за сколько минут до начала и в какие каналы (не больше недели). */
export const Reminder = z.object({
  minutes: z.number().int().min(0).max(10_080),
  channels: z.array(ReminderChannel).min(1).max(REMINDER_CHANNELS.length),
})
export type Reminder = z.infer<typeof Reminder>

export const WorkingHours = z
  .object({ start: ClockTime, end: ClockTime })
  .refine((value) => value.start < value.end, 'начало рабочего дня раньше конца')
export type WorkingHours = z.infer<typeof WorkingHours>

export const DEFAULT_WORKING_HOURS: WorkingHours = { start: '09:00', end: '18:00' }
export const DEFAULT_REMINDERS: Reminder[] = [{ minutes: 15, channels: ['app'] }]

/**
 * Настройки календаря пользователя: рабочие часы (учитываются в подборе
 * времени), напоминания по умолчанию, отметки календарей в левой колонке,
 * добавленные в список чужие календари, включённые проекции.
 */
export const CalendarSettings = z.object({
  workingHours: WorkingHours.default(DEFAULT_WORKING_HOURS),
  defaultReminders: z.array(Reminder).max(5).default(DEFAULT_REMINDERS),
  defaultDurationMinutes: z.number().int().min(5).max(480).default(60),
  /**
   * Отметки календарей: `true` — показывать, `false` — скрыть. Без отметки
   * ресурсы скрыты, остальные календари видны.
   */
  shown: z
    .record(z.string(), z.boolean())
    .refine((value) => Object.keys(value).length <= 500, 'не больше 500 отметок')
    .default({}),
  addedCalendarIds: z.array(Uuid).max(200).default([]),
  /** Включённые проекции (`tasks.due`, …); `null` — все зарегистрированные. */
  projections: z.array(z.string().max(64)).max(20).nullable().default(null),
})
export type CalendarSettings = z.infer<typeof CalendarSettings>

export const CalendarSettingsInput = CalendarSettings.partial()
export type CalendarSettingsInput = z.infer<typeof CalendarSettingsInput>

/** Поставщик проекций: что можно включить в левой колонке. */
export const CalendarProjectionSource = z.object({
  key: z.string(),
  labelKey: z.string(),
  icon: z.string(),
})
export type CalendarProjectionSource = z.infer<typeof CalendarProjectionSource>
