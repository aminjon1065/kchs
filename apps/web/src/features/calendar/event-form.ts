import type {
  CalendarColor,
  CalendarRecord,
  EventEditScope,
  EventRecord,
  EventShowAs,
  EventVisibility,
  Reminder,
} from '@kchs/contracts'
import type { ApiBody } from '~/shared/api/route-types.js'
import type { EventDraft } from './calendar-store.js'
import type { Invitee } from './people-picker.js'
import { buildRule, parseRule, presetOf, type RepeatPreset, type RepeatRule } from './recurrence.js'
import { clockText, MINUTE_MS, wallOf } from './time.js'

/**
 * Состояние формы события (12-calendar-notifications-home.md §1): что открыть, начальные
 * значения из заготовки или записи, тело запроса из формы.
 */

/** Что открыть в форме: новое событие (заготовка) или правку (экземпляр серии). */
export type EditorTarget =
  | { mode: 'create'; draft: EventDraft }
  | {
      mode: 'edit'
      record: EventRecord
      occurrence: EventRecord['occurrence']
    }

export interface FormState {
  title: string
  calendarId: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  repeat: RepeatPreset
  custom: RepeatRule
  location: string
  resourceIds: string[]
  attendees: Invitee[]
  visibility: EventVisibility
  showAs: EventShowAs
  reminders: Reminder[]
  color: CalendarColor | null
  description: string
  /** Онлайн-встреча: для события поднимается комната медиасервера (ADR-0089). */
  onlineMeeting: boolean
}

export function editableCalendars(calendars: CalendarRecord[]): CalendarRecord[] {
  return calendars.filter((calendar) => calendar.can.edit)
}

export function initialForm(target: EditorTarget, tz: string): FormState {
  const blank: FormState = {
    title: '',
    calendarId: '',
    allDay: false,
    startDate: '',
    startTime: '09:00',
    endDate: '',
    endTime: '10:00',
    repeat: 'none',
    custom: {
      freq: 'WEEKLY',
      interval: 1,
      byDay: [],
      byMonthDay: null,
      end: { kind: 'never' },
    },
    location: '',
    resourceIds: [],
    attendees: [],
    visibility: 'public',
    showAs: 'busy',
    reminders: [],
    color: null,
    description: '',
    onlineMeeting: false,
  }
  if (target.mode === 'create') {
    const draft = target.draft
    const chosen = {
      title: draft.title ?? '',
      calendarId: draft.calendarId ?? '',
      attendees: draft.attendees ?? [],
      resourceIds: draft.resourceIds ?? [],
    }
    if (draft.allDay) {
      const date = draft.date ?? wallOf(draft.start ?? Date.now(), tz).date
      return {
        ...blank,
        ...chosen,
        allDay: true,
        showAs: 'free',
        startDate: date,
        endDate: date,
      }
    }
    const start = draft.start ?? roundedNow()
    const end = draft.end ?? start + 60 * MINUTE_MS
    const from = wallOf(start, tz)
    const to = wallOf(end, tz)
    return {
      ...blank,
      ...chosen,
      startDate: from.date,
      startTime: clockText(from.minute),
      endDate: to.date,
      endTime: clockText(to.minute),
    }
  }
  const { record, occurrence } = target
  const startsAt = occurrence?.startsAt ?? record.startsAt
  const endsAt = occurrence?.endsAt ?? record.endsAt
  const from = wallOf(Date.parse(startsAt), tz)
  const to = wallOf(Date.parse(endsAt), tz)
  const startDate = record.allDay
    ? (occurrence?.startDate ?? record.startDate ?? from.date)
    : from.date
  const parsed = parseRule(record.rrule, tz)
  const preset = presetOf(parsed, startDate)
  return {
    ...blank,
    title: record.title,
    calendarId: record.calendar.id,
    allDay: record.allDay,
    startDate,
    startTime: clockText(from.minute),
    endDate: record.allDay ? (occurrence?.endDate ?? record.endDate ?? startDate) : to.date,
    endTime: clockText(to.minute),
    repeat: preset,
    custom: parsed ?? blank.custom,
    location: record.location ?? '',
    resourceIds: record.resources.map((item) => item.id),
    attendees: record.attendees
      .filter((item) => item.role === 'attendee')
      .map((item) => ({
        id: item.user.id,
        title: item.user.displayName,
        subtitle: item.user.position ?? item.user.unitName ?? null,
        avatarUrl: item.user.avatarUrl,
        optional: item.optional,
        status: item.status,
      })),
    visibility: record.visibility,
    showAs: record.showAs,
    onlineMeeting: record.meetingId !== null,
    reminders: record.reminders,
    color: record.color,
    description: record.description ?? '',
  }
}

function roundedNow(): number {
  const step = 30 * MINUTE_MS
  return Math.ceil(Date.now() / step) * step
}

export function payloadOf(
  form: FormState,
  rule: RepeatRule | null,
  times: { start: number; end: number } | null,
  scope: EventEditScope | null,
): ApiBody<'POST /events'> & { scope?: EventEditScope } {
  const time = form.allDay
    ? { allDay: true, startDate: form.startDate, endDate: form.endDate }
    : {
        allDay: false,
        startsAt: new Date(times?.start ?? 0).toISOString(),
        endsAt: new Date(times?.end ?? 0).toISOString(),
      }
  const text = (value: string) => value.trim() || null
  // Один экземпляр серии: только время, название, место и описание
  if (scope === 'occurrence') {
    return {
      ...time,
      title: form.title.trim(),
      location: text(form.location),
      description: text(form.description),
    }
  }
  return {
    ...time,
    ...(scope ? { scope } : {}),
    title: form.title.trim(),
    calendarId: form.calendarId,
    rrule: rule ? buildRule(rule) : null,
    location: text(form.location),
    description: text(form.description),
    visibility: form.visibility,
    showAs: form.showAs,
    color: form.color,
    reminders: form.reminders,
    attendees: form.attendees.map((item) => ({ userId: item.id, optional: item.optional })),
    resourceIds: form.resourceIds,
    onlineMeeting: form.onlineMeeting,
  }
}
