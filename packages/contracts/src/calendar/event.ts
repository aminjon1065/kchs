import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { ObjectSummary, ObjectType } from '../objects/object.js'
import {
  CalendarColor,
  CalendarKind,
  Reminder,
  ResourceKind,
  TimeZoneName,
  WorkingHours,
} from './calendar.js'

/**
 * События календаря (12-calendar-notifications-home.md §1, ADR-0081): объекты
 * реестра типа `event`, дочерние объекты календаря. Повтор — правило RRULE
 * (RFC 5545) с исключениями; экземпляры материализуются на два года вперёд.
 */

/**
 * Видимость: `public` — детали видят все, кто видит календарь; `busy` — прочие
 * видят только «занято», детали — участники и те, кто правит календарь;
 * `private` — детали только участникам, всем остальным (и администратору) — «занято».
 */
export const EVENT_VISIBILITIES = ['public', 'busy', 'private'] as const
export const EventVisibility = z.enum(EVENT_VISIBILITIES)
export type EventVisibility = z.infer<typeof EventVisibility>

/** Показывать время как занятое (учитывается в поиске времени) или свободное. */
export const EventShowAs = z.enum(['busy', 'free'])
export type EventShowAs = z.infer<typeof EventShowAs>

export const ATTENDEE_STATUSES = ['needs_action', 'accepted', 'tentative', 'declined'] as const
export const AttendeeStatus = z.enum(ATTENDEE_STATUSES)
export type AttendeeStatus = z.infer<typeof AttendeeStatus>

/** Ответ на приглашение: да, возможно, нет. */
export const RESPONSE_STATUSES = ['accepted', 'tentative', 'declined'] as const
export const ResponseStatus = z.enum(RESPONSE_STATUSES)
export type ResponseStatus = z.infer<typeof ResponseStatus>

/** Правка повторяющегося события: только это, это и следующие, вся серия. */
export const EVENT_EDIT_SCOPES = ['occurrence', 'following', 'series'] as const
export const EventEditScope = z.enum(EVENT_EDIT_SCOPES)
export type EventEditScope = z.infer<typeof EventEditScope>

export const EventSource = z.enum(['local', 'import', 'subscription'])
export type EventSource = z.infer<typeof EventSource>

/**
 * Правило повтора RFC 5545 без префикса `RRULE:`: частота не чаще раза в день
 * (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`). Полную проверку выполняет сервер.
 */
export const RecurrenceRule = z
  .string()
  .trim()
  .max(500)
  .regex(
    /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Za-z0-9,+\-:]+)*$/,
    'правило повтора RRULE: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY;…',
  )
export type RecurrenceRule = z.infer<typeof RecurrenceRule>

/** Предложение участника перенести встречу. */
export const TimeProposal = z.object({
  startsAt: Timestamp,
  endsAt: Timestamp,
  /** Экземпляр повторяющегося события, к которому относится предложение. */
  recurrenceId: Timestamp.nullable().default(null),
})
export type TimeProposal = z.infer<typeof TimeProposal>

export const EventAttendee = z.object({
  user: UserRef,
  role: z.enum(['organizer', 'attendee']),
  optional: z.boolean(),
  status: AttendeeStatus,
  comment: z.string().nullable(),
  proposal: TimeProposal.nullable(),
  respondedAt: Timestamp.nullable(),
})
export type EventAttendee = z.infer<typeof EventAttendee>

export const EventResourceRef = z.object({
  id: Uuid,
  title: z.string(),
  kind: ResourceKind,
  location: z.string().nullable(),
  color: CalendarColor,
})
export type EventResourceRef = z.infer<typeof EventResourceRef>

/** Что пользователь может сделать с событием. */
export const EventPermissions = z.object({
  edit: z.boolean(),
  /** Ответить на приглашение (участник). */
  respond: z.boolean(),
  cancel: z.boolean(),
  /** Доступ и перенос — управляющий событием. */
  manage: z.boolean(),
})
export type EventPermissions = z.infer<typeof EventPermissions>

export const EventCalendarRef = z.object({
  id: Uuid,
  title: z.string(),
  kind: CalendarKind,
  color: CalendarColor,
})

/** Экземпляр события для поповера: время конкретного повторения. */
export const EventOccurrence = z.object({
  recurrenceId: Timestamp,
  startsAt: Timestamp,
  endsAt: Timestamp,
  startDate: DateOnly.nullable(),
  endDate: DateOnly.nullable(),
  overridden: z.boolean(),
})
export type EventOccurrence = z.infer<typeof EventOccurrence>

export const EventRecord = z.object({
  id: Uuid,
  calendar: EventCalendarRef,
  /** Детали скрыты (чужое личное событие): остальные поля пусты. */
  busy: z.boolean(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  /** Даты события на весь день; `endDate` — последний день включительно. */
  startDate: DateOnly.nullable(),
  endDate: DateOnly.nullable(),
  timezone: z.string(),
  rrule: z.string().nullable(),
  exdates: z.array(Timestamp),
  visibility: EventVisibility,
  showAs: EventShowAs,
  color: CalendarColor.nullable(),
  organizer: UserRef.nullable(),
  attendees: z.array(EventAttendee),
  resources: z.array(EventResourceRef),
  reminders: z.array(Reminder),
  /** Мои напоминания, если я задал свои (иначе действуют напоминания события). */
  myReminders: z.array(Reminder).nullable(),
  myStatus: AttendeeStatus.nullable(),
  linkedObjects: z.array(ObjectSummary),
  /** Встреча LiveKit — фаза 4: точка расширения, пока всегда `null`. */
  meetingId: Uuid.nullable(),
  source: EventSource,
  seriesId: Uuid.nullable(),
  occurrence: EventOccurrence.nullable(),
  can: EventPermissions,
  version: z.number().int(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type EventRecord = z.infer<typeof EventRecord>

const TimeFields = {
  allDay: z.boolean(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  startDate: DateOnly,
  /** Последний день события на весь день — включительно. */
  endDate: DateOnly,
  timezone: TimeZoneName,
}

const EventFields = {
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(20_000).nullable(),
  location: z.string().trim().max(500).nullable(),
  rrule: RecurrenceRule.nullable(),
  visibility: EventVisibility,
  showAs: EventShowAs,
  color: CalendarColor.nullable(),
  reminders: z.array(Reminder).max(5),
  attendees: z.array(z.object({ userId: Uuid, optional: z.boolean().default(false) })).max(200),
  resourceIds: z.array(Uuid).max(20),
  linkedObjectIds: z.array(Uuid).max(50),
}

type TimeLike = {
  allDay?: boolean | undefined
  startsAt?: string | undefined
  endsAt?: string | undefined
  startDate?: string | undefined
  endDate?: string | undefined
}

/** Время события согласовано: у события на весь день — даты, у остальных — моменты. */
function checkTime(value: TimeLike, context: z.RefinementCtx, required: boolean): void {
  const issue = (path: string, message: string) =>
    context.addIssue({ code: 'custom', path: [path], message })
  if (value.allDay) {
    if (required && (!value.startDate || !value.endDate)) {
      issue('startDate', 'укажите даты события')
    }
    if (value.startDate && value.endDate && value.endDate < value.startDate) {
      issue('endDate', 'окончание раньше начала')
    }
    return
  }
  if (required && (!value.startsAt || !value.endsAt)) issue('startsAt', 'укажите время события')
  if (value.startsAt && value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    issue('endsAt', 'окончание раньше начала')
  }
}

export const EventCreateInput = z
  .object({
    calendarId: Uuid.optional(),
    title: EventFields.title,
    description: EventFields.description.optional(),
    location: EventFields.location.optional(),
    allDay: TimeFields.allDay.default(false),
    startsAt: TimeFields.startsAt.optional(),
    endsAt: TimeFields.endsAt.optional(),
    startDate: TimeFields.startDate.optional(),
    endDate: TimeFields.endDate.optional(),
    timezone: TimeFields.timezone.optional(),
    rrule: EventFields.rrule.optional(),
    visibility: EventFields.visibility.default('public'),
    showAs: EventFields.showAs.optional(),
    color: EventFields.color.optional(),
    /** Не задано — напоминания по умолчанию из настроек пользователя. */
    reminders: EventFields.reminders.optional(),
    attendees: EventFields.attendees.default([]),
    resourceIds: EventFields.resourceIds.default([]),
    linkedObjectIds: EventFields.linkedObjectIds.default([]),
  })
  .superRefine((value, context) => checkTime(value, context, true))
export type EventCreateInput = z.infer<typeof EventCreateInput>

/**
 * Правка события. У повторяющегося — `scope` и `recurrenceId` экземпляра:
 * «только это» меняет время, название, место и описание одного повторения,
 * «это и следующие» делит серию, «вся серия» — само правило.
 */
export const EventUpdateInput = z
  .object({
    scope: EventEditScope.default('series'),
    recurrenceId: Timestamp.optional(),
    calendarId: Uuid.optional(),
    title: EventFields.title.optional(),
    description: EventFields.description.optional(),
    location: EventFields.location.optional(),
    allDay: TimeFields.allDay.optional(),
    startsAt: TimeFields.startsAt.optional(),
    endsAt: TimeFields.endsAt.optional(),
    startDate: TimeFields.startDate.optional(),
    endDate: TimeFields.endDate.optional(),
    timezone: TimeFields.timezone.optional(),
    rrule: EventFields.rrule.optional(),
    visibility: EventFields.visibility.optional(),
    showAs: EventFields.showAs.optional(),
    color: EventFields.color.optional(),
    reminders: EventFields.reminders.optional(),
    attendees: EventFields.attendees.optional(),
    resourceIds: EventFields.resourceIds.optional(),
    linkedObjectIds: EventFields.linkedObjectIds.optional(),
  })
  .superRefine((value, context) => {
    if (value.scope !== 'series' && !value.recurrenceId) {
      context.addIssue({
        code: 'custom',
        path: ['recurrenceId'],
        message: 'укажите экземпляр повторяющегося события',
      })
    }
    checkTime(value, context, false)
  })
export type EventUpdateInput = z.infer<typeof EventUpdateInput>

export const EventCancelInput = z
  .object({
    scope: EventEditScope.default('series'),
    recurrenceId: Timestamp.optional(),
    comment: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, context) => {
    if (value.scope !== 'series' && !value.recurrenceId) {
      context.addIssue({
        code: 'custom',
        path: ['recurrenceId'],
        message: 'укажите экземпляр повторяющегося события',
      })
    }
  })
export type EventCancelInput = z.infer<typeof EventCancelInput>

/** Ответ участника: да, возможно, нет — с комментарием и, при желании, другим временем. */
export const EventRespondInput = z.object({
  status: ResponseStatus,
  comment: z.string().trim().max(2000).optional(),
  proposal: TimeProposal.optional(),
})
export type EventRespondInput = z.infer<typeof EventRespondInput>

export const EventRemindersInput = z.object({
  /** `null` — вернуться к напоминаниям события. */
  reminders: z.array(Reminder).max(5).nullable(),
})
export type EventRemindersInput = z.infer<typeof EventRemindersInput>

// ─── Выборка диапазона ────────────────────────────────────────────────────

const IdList = z
  .string()
  .max(40 * 60)
  .regex(/^[0-9a-f-]+(,[0-9a-f-]+)*$/i, 'идентификаторы через запятую')

export const CalendarRangeQuery = z
  .object({
    from: Timestamp,
    to: Timestamp,
    /** Календари через запятую; не заданы — видимые календари моего списка. */
    calendarIds: IdList.optional(),
    /** Проекции через запятую; не заданы — включённые в настройках. */
    projections: z.string().max(500).optional(),
    /** `true` — только мои события (личный календарь и приглашения). */
    mine: z.stringbool().optional(),
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    path: ['to'],
    message: 'конец диапазона раньше начала',
  })
  .refine((value) => Date.parse(value.to) - Date.parse(value.from) <= 62 * 86_400_000, {
    path: ['to'],
    message: 'диапазон — не больше 62 дней',
  })
export type CalendarRangeQuery = z.infer<typeof CalendarRangeQuery>

/**
 * Экземпляр события в диапазоне. Чужое событие с закрытыми деталями приходит
 * как «занято»: без идентификатора, названия и участников.
 */
export const CalendarRangeItem = z.object({
  /** Уникальный ключ экземпляра в ответе. */
  key: z.string(),
  eventId: Uuid.nullable(),
  calendarId: Uuid,
  recurrenceId: Timestamp.nullable(),
  recurring: z.boolean(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  allDay: z.boolean(),
  startDate: DateOnly.nullable(),
  /** Последний день включительно. */
  endDate: DateOnly.nullable(),
  busy: z.boolean(),
  title: z.string().nullable(),
  location: z.string().nullable(),
  color: CalendarColor,
  visibility: EventVisibility.nullable(),
  showAs: EventShowAs,
  myStatus: AttendeeStatus.nullable(),
  organizer: UserRef.nullable(),
  attendeeCount: z.number().int(),
  /** Я приглашён (событие чужого календаря в моём личном). */
  invitation: z.boolean(),
  hasMeeting: z.boolean(),
  canEdit: z.boolean(),
})
export type CalendarRangeItem = z.infer<typeof CalendarRangeItem>

/**
 * Проекция — виртуальное событие другого модуля (срок задачи или поручения,
 * срок документа на контроле): не хранится в календаре, ведёт к объекту.
 */
export const CalendarProjectionItem = z.object({
  key: z.string(),
  provider: z.string(),
  objectId: Uuid,
  objectType: ObjectType,
  title: z.string(),
  subtitle: z.string().nullable(),
  /** Дата в поясе пользователя. */
  date: DateOnly,
  /** Точное время, если срок не «до конца дня». */
  at: Timestamp.nullable(),
  status: z.string().nullable(),
  overdue: z.boolean(),
  done: z.boolean(),
})
export type CalendarProjectionItem = z.infer<typeof CalendarProjectionItem>

export const CalendarRange = z.object({
  items: z.array(CalendarRangeItem),
  projections: z.array(CalendarProjectionItem),
  /** Экземпляров больше предела ответа — диапазон нужно сузить. */
  truncated: z.boolean(),
})
export type CalendarRange = z.infer<typeof CalendarRange>

// ─── Занятость и подбор времени ───────────────────────────────────────────

export const BusyInterval = z.object({
  startsAt: Timestamp,
  endsAt: Timestamp,
  /** `tentative` — ответ «возможно» или ещё без ответа. */
  status: z.enum(['busy', 'tentative']),
  /** Название — только если детали события видны запрашивающему. */
  title: z.string().nullable(),
})
export type BusyInterval = z.infer<typeof BusyInterval>

export const FreeBusyPerson = z.object({
  user: UserRef,
  timezone: z.string(),
  workingHours: WorkingHours,
  busy: z.array(BusyInterval),
})
export type FreeBusyPerson = z.infer<typeof FreeBusyPerson>

export const FreeBusyResource = z.object({
  resource: EventResourceRef,
  busy: z.array(BusyInterval),
})
export type FreeBusyResource = z.infer<typeof FreeBusyResource>

export const FreeBusyQuery = z
  .object({
    from: Timestamp,
    to: Timestamp,
    userIds: IdList.optional(),
    resourceIds: IdList.optional(),
    /** Событие, которое переносим: его время не считается занятым. */
    excludeEventId: Uuid.optional(),
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    path: ['to'],
    message: 'конец диапазона раньше начала',
  })
  .refine((value) => Date.parse(value.to) - Date.parse(value.from) <= 31 * 86_400_000, {
    path: ['to'],
    message: 'диапазон — не больше 31 дня',
  })
export type FreeBusyQuery = z.infer<typeof FreeBusyQuery>

export const FreeBusyResult = z.object({
  people: z.array(FreeBusyPerson),
  resources: z.array(FreeBusyResource),
  /** Рабочие дни диапазона по производственному календарю (даты в поясе установки). */
  nonWorkingDays: z.array(DateOnly),
})
export type FreeBusyResult = z.infer<typeof FreeBusyResult>

export const FindTimeInput = z
  .object({
    userIds: z.array(Uuid).max(50).default([]),
    /** Необязательные участники: их занятость снижает оценку окна, но не исключает его. */
    optionalUserIds: z.array(Uuid).max(50).default([]),
    resourceIds: z.array(Uuid).max(10).default([]),
    durationMinutes: z.number().int().min(5).max(480),
    from: Timestamp,
    to: Timestamp,
    /** Только рабочие часы участников и рабочие дни производственного календаря. */
    workingHoursOnly: z.boolean().default(true),
    excludeEventId: Uuid.optional(),
    limit: z.number().int().min(1).max(30).default(10),
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    path: ['to'],
    message: 'конец диапазона раньше начала',
  })
  .refine((value) => Date.parse(value.to) - Date.parse(value.from) <= 31 * 86_400_000, {
    path: ['to'],
    message: 'диапазон — не больше 31 дня',
  })
export type FindTimeInput = z.infer<typeof FindTimeInput>

export const TimeSlot = z.object({
  startsAt: Timestamp,
  endsAt: Timestamp,
  /** Сколько необязательных участников заняты в это время. */
  optionalBusy: z.number().int(),
})
export type TimeSlot = z.infer<typeof TimeSlot>

export const FindTimeResult = z.object({
  slots: z.array(TimeSlot),
  freeBusy: FreeBusyResult,
})
export type FindTimeResult = z.infer<typeof FindTimeResult>
