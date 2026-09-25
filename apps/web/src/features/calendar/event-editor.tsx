import {
  CALENDAR_COLORS,
  type CalendarColor,
  type CalendarRecord,
  type EventEditScope,
  type EventRecord,
  type EventShowAs,
  type EventVisibility,
  type MeetingsStatus,
  type PrincipalRef,
  type Reminder,
  type ReminderChannel,
} from '@kchs/contracts'
import {
  Button,
  CalendarColorPicker,
  Callout,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toneClasses,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Bell, CalendarSearch, Plus, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import type { EventDraft } from './calendar-store.js'
import { FindTimeSheet } from './find-time.js'
import { useCalendarFormat } from './format.js'
import { type Invitee, PeoplePicker } from './people-picker.js'
import { calendarSettingsQuery, calendarsQuery, useCalendarInvalidation } from './queries.js'
import {
  buildRule,
  describeRule,
  nthWeekday,
  parseRule,
  presetOf,
  presetRule,
  REPEAT_PRESETS,
  type RepeatPreset,
  type RepeatRule,
  WEEK_ORDER,
  weekdayName,
} from './recurrence.js'
import { ScopeDialog } from './scope-dialog.js'
import { addDays, clockMinutes, clockText, DAY_MS, instantAt, MINUTE_MS, wallOf } from './time.js'

const REMINDER_MINUTES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880]
const CHANNELS: ReminderChannel[] = ['app', 'email', 'telegram', 'push']

/** Что открыть в форме: новое событие (заготовка) или правку (экземпляр серии). */
export type EditorTarget =
  | { mode: 'create'; draft: EventDraft }
  | {
      mode: 'edit'
      record: EventRecord
      occurrence: EventRecord['occurrence']
    }

interface FormState {
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

/** Подпись напоминания: «в начале», «за 15 мин», «за 2 ч», «за 1 дн.». */
export function reminderLabel(
  minutes: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (minutes === 0) return t('calendar.reminders.atStart')
  if (minutes < 60) return t('calendar.reminders.minutes', { count: minutes })
  if (minutes < 1440) return t('calendar.reminders.hours', { count: minutes / 60 })
  return t('calendar.reminders.days', { count: minutes / 1440 })
}

function editableCalendars(calendars: CalendarRecord[]): CalendarRecord[] {
  return calendars.filter((calendar) => calendar.can.edit)
}

/**
 * Форма события: время или весь день, повтор, место и ресурсы, участники,
 * видимость, напоминания, цвет, описание; «Найти время» — подбор окна по
 * занятости. У повторяющегося события сохранение спрашивает, что менять.
 */
export function EventEditor({
  target,
  onClose,
  onSaved,
}: {
  target: EditorTarget
  onClose: () => void
  onSaved?: (id: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const format = useCalendarFormat()
  const invalidate = useCalendarInvalidation()
  const openTab = useWorkspace((s) => s.openTab)
  const ids = { title: useId(), location: useId(), description: useId() }
  const tz = format.timezone
  const { data: me } = useQuery(meQuery())
  const { data: calendars = [] } = useQuery(calendarsQuery({ scope: 'mine' }))
  const { data: settings } = useQuery(calendarSettingsQuery())
  // Без медиасервера онлайн-встречи не поднимаются — переключателя нет (ADR-0089)
  const { data: meetings } = useQuery({
    queryKey: ['meetings', 'status'],
    queryFn: () => http.get<MeetingsStatus>('/meetings/status'),
    staleTime: 5 * 60_000,
  })
  const meetingsEnabled = meetings?.enabled ?? false
  const resources = calendars.filter((calendar) => calendar.kind === 'resource')
  const writable = editableCalendars(calendars)
  const personal = calendars.find((calendar) => calendar.mine)

  const [form, setForm] = useState<FormState>(() => initialForm(target, tz))
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [askScope, setAskScope] = useState(false)
  const [finding, setFinding] = useState(false)
  /** Повтор меняли в форме: иначе правило серии не отправляется (импортированное бывает сложнее формы). */
  const [repeatDirty, setRepeatDirty] = useState(false)
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }))
  const defaultCalendarId =
    (target.mode === 'create' ? target.draft.calendarId : undefined) ??
    personal?.id ??
    writable[0]?.id ??
    ''
  const defaultReminders = settings?.defaultReminders

  // Календарь и напоминания по умолчанию — когда пришли настройки и список
  useEffect(() => {
    if (target.mode !== 'create') return
    setForm((current) => {
      const calendarId = current.calendarId || defaultCalendarId
      const reminders =
        current.reminders.length || !defaultReminders ? current.reminders : defaultReminders
      if (calendarId === current.calendarId && reminders === current.reminders) return current
      return { ...current, calendarId, reminders }
    })
  }, [target.mode, defaultCalendarId, defaultReminders])

  // Участники из быстрого создания: фамилии ищутся среди сотрудников
  useEffect(() => {
    if (target.mode !== 'create' || !target.draft.people?.length) return
    let cancelled = false
    void Promise.all(
      target.draft.people.map((name) =>
        http
          .get<{ items: PrincipalRef[] }>('/principals/search', {
            query: { q: name, types: 'user', limit: 1 },
          })
          .then((response) => response.items[0] ?? null)
          .catch(() => null),
      ),
    ).then((found) => {
      if (cancelled) return
      const people = found.filter((item): item is PrincipalRef => item !== null)
      setForm((current) => ({
        ...current,
        attendees: [
          ...current.attendees,
          ...people
            .filter((person) => !current.attendees.some((item) => item.id === person.id))
            .map((person) => ({
              id: person.id,
              title: person.title,
              subtitle: person.subtitle ?? null,
              avatarUrl: person.avatarUrl ?? null,
              optional: false,
            })),
        ],
      }))
    })
    return () => {
      cancelled = true
    }
  }, [target])

  const rule: RepeatRule | null =
    form.repeat === 'none'
      ? null
      : form.repeat === 'custom'
        ? form.custom
        : presetRule(form.repeat, form.startDate)

  const times = useMemo(() => {
    if (form.allDay) return null
    const start = instantAt(form.startDate, clockMinutes(form.startTime), tz)
    const end = instantAt(form.endDate, clockMinutes(form.endTime), tz)
    return { start, end }
  }, [form.allDay, form.startDate, form.startTime, form.endDate, form.endTime, tz])

  const record = target.mode === 'edit' ? target.record : null
  const recurring = Boolean(record?.rrule)
  /** Поля серии изменились — «только это» недоступно. */
  const seriesChanged =
    record !== null &&
    (form.calendarId !== record.calendar.id ||
      repeatDirty ||
      form.visibility !== record.visibility ||
      form.showAs !== record.showAs ||
      form.color !== record.color ||
      JSON.stringify(form.reminders) !== JSON.stringify(record.reminders) ||
      form.attendees.map((item) => `${item.id}:${item.optional}`).join() !==
        record.attendees
          .filter((item) => item.role === 'attendee')
          .map((item) => `${item.user.id}:${item.optional}`)
          .join() ||
      form.resourceIds.join() !== record.resources.map((item) => item.id).join())

  const save = useMutation({
    mutationFn: async (scope: EventEditScope | null) => {
      if (target.mode === 'create') {
        // Время введено по часам пользователя — в его поясе и повторяется
        const body = { ...payloadOf(form, rule, times, null), timezone: tz }
        return (await http.post<{ id: string }>('/events', body)).id
      }
      const record = target.record
      const body = payloadOf(form, rule, times, scope)
      if (!repeatDirty) delete body.rrule
      if (scope && scope !== 'series' && target.occurrence) {
        Object.assign(body, { scope, recurrenceId: target.occurrence.recurrenceId })
      } else if (scope === 'series' && target.occurrence && times) {
        // Правка из экземпляра для всей серии: время серии сдвигается так же
        const delta = times.start - Date.parse(target.occurrence.startsAt)
        Object.assign(body, {
          scope: 'series',
          startsAt: new Date(Date.parse(record.startsAt) + delta).toISOString(),
          endsAt: new Date(
            Date.parse(record.startsAt) + delta + (times.end - times.start),
          ).toISOString(),
        })
      } else if (scope === 'series' && target.occurrence && form.allDay) {
        const shift = Math.round(
          (Date.parse(`${form.startDate}T00:00:00Z`) -
            Date.parse(`${target.occurrence.startDate ?? form.startDate}T00:00:00Z`)) /
            DAY_MS,
        )
        const span = Math.round(
          (Date.parse(`${form.endDate}T00:00:00Z`) - Date.parse(`${form.startDate}T00:00:00Z`)) /
            DAY_MS,
        )
        const startDate = addDays(record.startDate ?? form.startDate, shift)
        Object.assign(body, { scope: 'series', startDate, endDate: addDays(startDate, span) })
      }
      return (await http.patch<{ id: string }>(`/events/${record.id}`, body)).id
    },
    onSuccess: (id) => {
      invalidate(id)
      toast.show({
        title: t(target.mode === 'create' ? 'calendar.event.created' : 'calendar.event.saved'),
        tone: 'success',
        ...(target.mode === 'create'
          ? {
              action: {
                label: t('common.actions.open'),
                onClick: () =>
                  openTab({
                    kind: 'object',
                    objectId: id,
                    objectType: 'event',
                    title: form.title,
                    mode: 'permanent',
                  }),
              },
            }
          : {}),
      })
      onSaved?.(id)
      onClose()
    },
    onError: (failure) => {
      setAskScope(false)
      if (failure instanceof ApiError) {
        setFieldErrors(failure.fieldErrors())
        const conflicts = (
          failure.problem as { data?: { conflicts?: Array<{ startsAt: string; endsAt: string }> } }
        ).data?.conflicts
        setError(
          conflicts?.length
            ? t('calendar.event.conflict', {
                times: conflicts
                  .map((item) =>
                    format.when({
                      startsAt: item.startsAt,
                      endsAt: item.endsAt,
                      allDay: false,
                      startDate: null,
                      endDate: null,
                    }),
                  )
                  .join('; '),
              })
            : failure.message,
        )
        return
      }
      setError(t('errors.unknown'))
    },
  })

  const valid =
    form.title.trim().length > 0 &&
    Boolean(form.calendarId) &&
    (form.allDay ? form.endDate >= form.startDate : Boolean(times && times.end > times.start))

  const submit = () => {
    setError(null)
    if (recurring && target.mode === 'edit' && target.occurrence) {
      setAskScope(true)
      return
    }
    save.mutate(target.mode === 'edit' ? 'series' : null)
  }

  const setStartDate = (value: string) => {
    if (!value) return
    // Длительность сохраняется при переносе начала
    const shift = Math.round(
      (Date.parse(`${value}T00:00:00Z`) - Date.parse(`${form.startDate}T00:00:00Z`)) / DAY_MS,
    )
    update({ startDate: value, endDate: addDays(form.endDate, shift) })
  }
  const setStartTime = (value: string) => {
    if (!value || !times) return
    const duration = times.end - times.start
    const start = instantAt(form.startDate, clockMinutes(value), tz)
    const end = wallOf(start + duration, tz)
    update({ startTime: value, endDate: end.date, endTime: clockText(end.minute) })
  }

  const duration = times ? Math.max(15, Math.round((times.end - times.start) / MINUTE_MS)) : 60
  const presetLabel = (preset: RepeatPreset): string => {
    if (preset === 'custom') return t('calendar.repeat.presets.custom')
    if (preset === 'none') return t('calendar.repeat.none')
    return describeRule(presetRule(preset, form.startDate), t, format.intlLocale, format.shortDate)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="lg"
        title={t(target.mode === 'create' ? 'calendar.event.newTitle' : 'calendar.event.editTitle')}
        footer={
          <>
            <Button
              variant="ghost"
              icon={<CalendarSearch className="size-4" />}
              className="mr-auto"
              onClick={() => setFinding(true)}
            >
              {t('calendar.findTime.title')}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
              {t(target.mode === 'create' ? 'common.actions.create' : 'common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field
            label={t('calendar.event.title')}
            htmlFor={ids.title}
            error={fieldErrors.title}
            required
          >
            <Input
              id={ids.title}
              autoFocus
              value={form.title}
              placeholder={t('calendar.event.titlePlaceholder')}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>

          <div className="flex flex-col gap-2 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-end gap-2">
              <DateTimeInput
                label={t('calendar.event.start')}
                date={form.startDate}
                time={form.allDay ? null : form.startTime}
                onDate={setStartDate}
                onTime={setStartTime}
              />
              <span className="pb-2 text-fg-muted" aria-hidden>
                —
              </span>
              <DateTimeInput
                label={t('calendar.event.end')}
                date={form.endDate}
                time={form.allDay ? null : form.endTime}
                onDate={(value) => value && update({ endDate: value })}
                onTime={(value) => value && update({ endTime: value })}
                error={fieldErrors.endsAt ?? fieldErrors.endDate}
              />
              <Switch
                className="mb-2"
                checked={form.allDay}
                onCheckedChange={(allDay) =>
                  update({
                    allDay,
                    showAs: allDay ? 'free' : 'busy',
                    ...(allDay ? {} : { endDate: form.startDate }),
                  })
                }
                label={t('calendar.event.allDay')}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={form.repeat}
                onValueChange={(value) => {
                  const preset = value as RepeatPreset
                  setRepeatDirty(true)
                  update({
                    repeat: preset,
                    ...(preset === 'custom'
                      ? {
                          custom: rule ?? presetRule('weekly', form.startDate) ?? form.custom,
                        }
                      : {}),
                  })
                }}
              >
                <SelectTrigger aria-label={t('calendar.event.repeat')} className="w-auto min-w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPEAT_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {presetLabel(preset)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.repeat !== 'none' && rule ? (
                <span className="text-xs text-fg-muted">
                  {describeRule(rule, t, format.intlLocale, format.shortDate)}
                </span>
              ) : null}
            </div>
            {form.repeat === 'custom' ? (
              <CustomRepeat
                value={form.custom}
                startDate={form.startDate}
                onChange={(custom) => {
                  setRepeatDirty(true)
                  update({ custom })
                }}
              />
            ) : null}
            {fieldErrors.rrule ? <p className="text-xs text-danger">{fieldErrors.rrule}</p> : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('calendar.event.calendar')}>
              <Select
                value={form.calendarId}
                onValueChange={(calendarId) => update({ calendarId })}
              >
                <SelectTrigger aria-label={t('calendar.event.calendar')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {writable.map((calendar) => (
                    <SelectItem key={calendar.id} value={calendar.id}>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn('size-2.5 rounded-full', toneClasses(calendar.color).dot)}
                        />
                        {calendar.mine ? t('calendar.sidebar.myCalendar') : calendar.title}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('calendar.event.location')} htmlFor={ids.location}>
              <Input
                id={ids.location}
                value={form.location}
                onChange={(event) => update({ location: event.target.value })}
              />
            </Field>
          </div>

          {/* Онлайн-встреча (ADR-0089): комната поднимается вместе с событием */}
          {meetingsEnabled ? (
            <div className="flex flex-col gap-1">
              <Switch
                checked={form.onlineMeeting}
                onCheckedChange={(onlineMeeting) => update({ onlineMeeting })}
                label={t('calendar.event.onlineMeeting')}
              />
              <p className="text-xs text-fg-muted">{t('calendar.event.onlineMeetingHint')}</p>
            </div>
          ) : null}

          <Field label={t('calendar.event.resources')}>
            <div className="flex flex-col gap-1.5">
              {form.resourceIds.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5" aria-label={t('calendar.event.resources')}>
                  {form.resourceIds.map((id) => {
                    const resource = resources.find((item) => item.id === id)
                    return (
                      <li
                        key={id}
                        className="flex items-center gap-1 rounded-sm border border-line bg-surface-2 py-0.5 pl-2 pr-0.5 text-sm"
                      >
                        {resource?.title ?? id}
                        <IconButton
                          size="sm"
                          label={t('calendar.event.removeResource', {
                            name: resource?.title ?? '',
                          })}
                          onClick={() =>
                            update({ resourceIds: form.resourceIds.filter((item) => item !== id) })
                          }
                        >
                          <X className="size-3" aria-hidden />
                        </IconButton>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              <Select
                value=""
                onValueChange={(id) => id && update({ resourceIds: [...form.resourceIds, id] })}
              >
                <SelectTrigger aria-label={t('calendar.event.addResource')} className="w-72">
                  <SelectValue placeholder={t('calendar.event.addResource')} />
                </SelectTrigger>
                <SelectContent>
                  {resources
                    .filter((resource) => !form.resourceIds.includes(resource.id))
                    .map((resource) => (
                      <SelectItem key={resource.id} value={resource.id}>
                        {resource.title}
                        {resource.resource?.capacity
                          ? ` · ${t('calendar.event.capacity', { count: resource.resource.capacity })}`
                          : ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </Field>

          <Field label={t('calendar.event.attendees')} error={fieldErrors.attendees}>
            <PeoplePicker
              value={form.attendees}
              onChange={(attendees) => update({ attendees })}
              exclude={record?.organizer ? [record.organizer.id] : me ? [me.user.id] : []}
              label={t('calendar.event.attendees')}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('calendar.event.visibility')}>
              <SegmentedControl
                aria-label={t('calendar.event.visibility')}
                value={form.visibility}
                onValueChange={(visibility) => update({ visibility })}
                options={(['public', 'busy', 'private'] as const).map((value) => ({
                  value,
                  label: t(`calendar.visibility.${value}`),
                  title: t(`calendar.visibilityHint.${value}`),
                }))}
              />
            </Field>
            <Field label={t('calendar.event.showAs')}>
              <SegmentedControl
                aria-label={t('calendar.event.showAs')}
                value={form.showAs}
                onValueChange={(showAs) => update({ showAs })}
                options={(['busy', 'free'] as const).map((value) => ({
                  value,
                  label: t(`calendar.showAs.${value}`),
                }))}
              />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-fg-muted">
            {t(`calendar.visibilityHint.${form.visibility}`)}
          </p>

          <Field label={t('calendar.event.reminders')}>
            <RemindersInput
              value={form.reminders}
              onChange={(reminders) => update({ reminders })}
            />
          </Field>

          <Field label={t('calendar.event.color')}>
            <ColorInput value={form.color} onChange={(color) => update({ color })} />
          </Field>

          <Field label={t('calendar.event.description')} htmlFor={ids.description}>
            <Textarea
              id={ids.description}
              rows={3}
              value={form.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </Field>
        </div>
      </DialogContent>

      {askScope ? (
        <ScopeDialog
          mode="edit"
          allowOccurrence={!seriesChanged}
          loading={save.isPending}
          onClose={() => setAskScope(false)}
          onConfirm={(scope) => save.mutate(scope)}
        />
      ) : null}
      {finding && me ? (
        <FindTimeSheet
          me={{ id: me.user.id, title: me.user.displayName, avatarUrl: me.user.avatarUrl }}
          attendees={form.attendees}
          resources={form.resourceIds.map((id) => ({
            id,
            title: resources.find((item) => item.id === id)?.title ?? id,
          }))}
          durationMinutes={duration}
          date={form.startDate}
          selection={times}
          excludeEventId={record?.id ?? null}
          resourceOptions={resources.map((item) => ({ id: item.id, title: item.title }))}
          onAttendeesChange={(attendees) => update({ attendees })}
          onResourcesChange={(resourceIds) => update({ resourceIds })}
          onClose={() => setFinding(false)}
          onPick={(start, end) => {
            const from = wallOf(start, tz)
            const to = wallOf(end, tz)
            update({
              allDay: false,
              startDate: from.date,
              startTime: clockText(from.minute),
              endDate: to.date,
              endTime: clockText(to.minute),
            })
            setFinding(false)
          }}
        />
      ) : null}
    </Dialog>
  )
}

function initialForm(target: EditorTarget, tz: string): FormState {
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

function payloadOf(
  form: FormState,
  rule: RepeatRule | null,
  times: { start: number; end: number } | null,
  scope: EventEditScope | null,
): Record<string, unknown> {
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

function DateTimeInput({
  label,
  date,
  time,
  onDate,
  onTime,
  error,
}: {
  label: string
  date: string
  time: string | null
  onDate: (value: string) => void
  onTime: (value: string) => void
  error?: string | undefined
}) {
  const t = useT()
  const dateId = useId()
  const timeId = useId()
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-secondary">{label}</span>
      <span className="flex gap-1.5">
        <label htmlFor={dateId} className="sr-only">
          {t('calendar.event.dateOf', { label })}
        </label>
        <Input
          id={dateId}
          type="date"
          value={date}
          onChange={(event) => onDate(event.target.value)}
          className="w-40"
        />
        {time !== null ? (
          <>
            <label htmlFor={timeId} className="sr-only">
              {t('calendar.event.timeOf', { label })}
            </label>
            <Input
              id={timeId}
              type="time"
              step={300}
              value={time}
              onChange={(event) => onTime(event.target.value)}
              className="w-28"
            />
          </>
        ) : null}
      </span>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  )
}

function CustomRepeat({
  value,
  startDate,
  onChange,
}: {
  value: RepeatRule
  startDate: string
  onChange: (next: RepeatRule) => void
}) {
  const t = useT()
  const format = useCalendarFormat()
  const intervalId = useId()
  const untilId = useId()
  const countId = useId()
  const nth = nthWeekday(startDate)
  return (
    <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={intervalId} className="text-sm text-fg-secondary">
          {t('calendar.repeat.every')}
        </label>
        <Input
          id={intervalId}
          type="number"
          min={1}
          max={99}
          value={value.interval}
          onChange={(event) =>
            onChange({ ...value, interval: Math.max(1, Number(event.target.value) || 1) })
          }
          className="w-20"
        />
        <Select
          value={value.freq}
          onValueChange={(freq) =>
            onChange({
              ...value,
              freq: freq as RepeatRule['freq'],
              byDay:
                freq === 'WEEKLY'
                  ? value.byDay.length
                    ? value.byDay
                    : [WEEK_ORDER[(new Date(`${startDate}T00:00:00Z`).getUTCDay() + 6) % 7] ?? 'MO']
                  : [],
              byMonthDay: freq === 'MONTHLY' ? Number(startDate.slice(8)) : null,
            })
          }
        >
          <SelectTrigger aria-label={t('calendar.repeat.unit')} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((freq) => (
              <SelectItem key={freq} value={freq}>
                {t(`calendar.repeat.units.${freq}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.freq === 'WEEKLY' ? (
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{t('calendar.repeat.onDays')}</legend>
          {WEEK_ORDER.map((code) => {
            const active = value.byDay.includes(code)
            return (
              <Button
                key={code}
                size="sm"
                variant={active ? 'subtle' : 'secondary'}
                aria-pressed={active}
                onClick={() => {
                  const next = active
                    ? value.byDay.filter((item) => item !== code)
                    : [...value.byDay, code]
                  if (next.length > 0) onChange({ ...value, byDay: next })
                }}
              >
                {weekdayName(code, format.intlLocale)}
              </Button>
            )
          })}
        </fieldset>
      ) : null}
      {value.freq === 'MONTHLY' ? (
        <SegmentedControl
          aria-label={t('calendar.repeat.monthlyMode')}
          value={value.byMonthDay !== null ? 'day' : 'nth'}
          onValueChange={(mode) =>
            onChange(
              mode === 'day'
                ? { ...value, byMonthDay: Number(startDate.slice(8)), byDay: [] }
                : { ...value, byMonthDay: null, byDay: [`${nth.nth}${nth.day}`] },
            )
          }
          options={[
            {
              value: 'day',
              label: t('calendar.repeat.monthlyDay', { day: Number(startDate.slice(8)) }),
            },
            {
              value: 'nth',
              label:
                nth.nth === -1
                  ? t('calendar.repeat.monthlyLastLabel', {
                      day: weekdayName(nth.day, format.intlLocale),
                    })
                  : t('calendar.repeat.monthlyNthLabel', {
                      nth: nth.nth,
                      day: weekdayName(nth.day, format.intlLocale),
                    }),
            },
          ]}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-secondary">{t('calendar.repeat.ends')}</span>
        <SegmentedControl
          aria-label={t('calendar.repeat.ends')}
          value={value.end.kind}
          onValueChange={(kind) =>
            onChange({
              ...value,
              end:
                kind === 'until'
                  ? { kind, date: addDays(startDate, 90) }
                  : kind === 'count'
                    ? { kind, count: 10 }
                    : { kind: 'never' },
            })
          }
          options={[
            { value: 'never', label: t('calendar.repeat.never') },
            { value: 'until', label: t('calendar.repeat.until') },
            { value: 'count', label: t('calendar.repeat.count') },
          ]}
        />
        {value.end.kind === 'until' ? (
          <>
            <label htmlFor={untilId} className="sr-only">
              {t('calendar.repeat.untilDate')}
            </label>
            <Input
              id={untilId}
              type="date"
              value={value.end.date}
              min={startDate}
              onChange={(event) =>
                event.target.value &&
                onChange({ ...value, end: { kind: 'until', date: event.target.value } })
              }
              className="w-40"
            />
          </>
        ) : null}
        {value.end.kind === 'count' ? (
          <>
            <label htmlFor={countId} className="sr-only">
              {t('calendar.repeat.countValue')}
            </label>
            <Input
              id={countId}
              type="number"
              min={1}
              max={1000}
              value={value.end.count}
              onChange={(event) =>
                onChange({
                  ...value,
                  end: { kind: 'count', count: Math.max(1, Number(event.target.value) || 1) },
                })
              }
              className="w-24"
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

export function RemindersInput({
  value,
  onChange,
}: {
  value: Reminder[]
  onChange: (next: Reminder[]) => void
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((reminder, index) => (
        <div
          // Напоминания — список без собственных идентификаторов, порядок стабилен
          key={index}
          className="flex flex-wrap items-center gap-2"
        >
          <Bell className="size-4 text-fg-muted" aria-hidden />
          <Select
            value={String(reminder.minutes)}
            onValueChange={(minutes) =>
              onChange(
                value.map((item, position) =>
                  position === index ? { ...item, minutes: Number(minutes) } : item,
                ),
              )
            }
          >
            <SelectTrigger aria-label={t('calendar.reminders.when')} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REMINDER_MINUTES.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {reminderLabel(minutes, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {CHANNELS.map((channel) => (
            <Checkbox
              key={channel}
              checked={reminder.channels.includes(channel)}
              label={t(`calendar.reminders.channels.${channel}`)}
              onCheckedChange={(checked) => {
                const channels = checked
                  ? [...reminder.channels, channel]
                  : reminder.channels.filter((item) => item !== channel)
                if (channels.length === 0) return
                onChange(
                  value.map((item, position) =>
                    position === index ? { ...item, channels } : item,
                  ),
                )
              }}
            />
          ))}
          <IconButton
            size="sm"
            label={t('calendar.reminders.remove')}
            onClick={() => onChange(value.filter((_, position) => position !== index))}
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        </div>
      ))}
      {value.length < 5 ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          icon={<Plus className="size-3.5" />}
          onClick={() => onChange([...value, { minutes: 15, channels: ['app'] }])}
        >
          {t('calendar.reminders.add')}
        </Button>
      ) : null}
    </div>
  )
}

export function ColorInput({
  value,
  onChange,
  allowDefault = true,
}: {
  value: CalendarColor | null
  onChange: (next: CalendarColor | null) => void
  allowDefault?: boolean
}) {
  const t = useT()
  const labels = Object.fromEntries(
    CALENDAR_COLORS.map((color) => [color, t(`calendar.colors.${color}`)]),
  ) as Record<CalendarColor, string>
  return (
    <CalendarColorPicker
      aria-label={t('calendar.event.color')}
      value={value}
      onChange={onChange}
      colors={CALENDAR_COLORS}
      labels={labels}
      defaultLabel={allowDefault ? t('calendar.event.calendarColor') : null}
    />
  )
}
