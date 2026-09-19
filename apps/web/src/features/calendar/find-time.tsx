import type { FindTimeResult } from '@kchs/contracts'
import {
  AvailabilityGrid,
  type AvailabilityRow,
  Avatar,
  Button,
  Callout,
  EmptyState,
  IconButton,
  Input,
  ObjectIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  Skeleton,
  Switch,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { CalendarSearch, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { useCalendarFormat } from './format.js'
import { type Invitee, PeoplePicker } from './people-picker.js'
import { freeBusyQuery } from './queries.js'
import { addDays, clockMinutes, instantAt, MINUTE_MS, wallOf } from './time.js'

const DURATIONS = [15, 30, 45, 60, 90, 120]
/** Шкала дня в сетке занятости: 07:00–21:00 по поясу пользователя. */
const DAY_FROM = 7 * 60
const DAY_TO = 21 * 60

/**
 * «Найти время» (12-calendar-notifications-home.md §1): занятость участников
 * и ресурсов на выбранный день («занято» без деталей там, где они закрыты) и
 * свободные окна на две недели в рабочие часы и рабочие дни. Участников и
 * ресурсы можно добавить прямо здесь — выбор возвращается в форму события.
 */
export function FindTimeSheet({
  me,
  attendees,
  resources,
  durationMinutes,
  date: initialDate,
  selection,
  excludeEventId,
  resourceOptions = [],
  onAttendeesChange,
  onResourcesChange,
  onPick,
  onClose,
}: {
  me: { id: string; title: string; avatarUrl: string | null }
  attendees: Invitee[]
  resources: Array<{ id: string; title: string }>
  durationMinutes: number
  date: string
  selection: { start: number; end: number } | null
  excludeEventId?: string | null
  /** Ресурсы, которые можно добавить (переговорные, техника). */
  resourceOptions?: Array<{ id: string; title: string }>
  onAttendeesChange?: (next: Invitee[]) => void
  onResourcesChange?: (ids: string[]) => void
  onPick: (start: number, end: number) => void
  onClose: () => void
}) {
  const t = useT()
  const format = useCalendarFormat()
  const dateId = useId()
  const [date, setDate] = useState(initialDate)
  const [duration, setDuration] = useState(durationMinutes)
  const [workingOnly, setWorkingOnly] = useState(true)
  const tz = format.timezone
  const dayStart = instantAt(date, DAY_FROM, tz)
  const dayEnd = instantAt(date, DAY_TO, tz)
  const people = [me.id, ...attendees.map((item) => item.id).filter((id) => id !== me.id)]
  const resourceIds = resources.map((item) => item.id)

  const { data: freeBusy, isLoading } = useQuery(
    freeBusyQuery({
      from: new Date(instantAt(date, 0, tz)).toISOString(),
      to: new Date(instantAt(addDays(date, 1), 0, tz)).toISOString(),
      userIds: people,
      resourceIds,
      excludeEventId: excludeEventId ?? null,
    }),
  )

  const optional = attendees.filter((item) => item.optional).map((item) => item.id)
  const { data: found, isFetching: searching } = useQuery({
    queryKey: [
      'calendar',
      'find-time',
      { date, duration, workingOnly, people, resourceIds, optional, excludeEventId },
    ],
    queryFn: () =>
      http.post<FindTimeResult>('/calendar/find-time', {
        userIds: people.filter((id) => !optional.includes(id)),
        optionalUserIds: optional,
        resourceIds,
        durationMinutes: duration,
        from: new Date(instantAt(date, 0, tz)).toISOString(),
        to: new Date(instantAt(addDays(date, 14), 0, tz)).toISOString(),
        workingHoursOnly: workingOnly,
        limit: 12,
        ...(excludeEventId ? { excludeEventId } : {}),
      }),
  })

  const rows: AvailabilityRow[] = (() => {
    if (!freeBusy) return []
    const byId = new Map(freeBusy.people.map((person) => [person.user.id, person]))
    const personRows = people.flatMap((id) => {
      const person = byId.get(id)
      if (!person) return []
      const nonWorking = freeBusy.nonWorkingDays.includes(date)
      const invitee = attendees.find((item) => item.id === id)
      return [
        {
          key: id,
          label: id === me.id ? t('calendar.findTime.you') : person.user.displayName,
          sublabel: invitee?.optional
            ? t('calendar.event.optional')
            : (person.user.position ?? person.user.unitName ?? null),
          icon: <Avatar name={person.user.displayName} src={person.user.avatarUrl} size="sm" />,
          working: nonWorking
            ? []
            : [
                {
                  start: instantAt(date, clockMinutes(person.workingHours.start), person.timezone),
                  end: instantAt(date, clockMinutes(person.workingHours.end), person.timezone),
                },
              ],
          busy: person.busy.map((item) => ({
            start: Date.parse(item.startsAt),
            end: Date.parse(item.endsAt),
            tentative: item.status === 'tentative',
            title: item.title,
          })),
        },
      ]
    })
    const resourceRows = freeBusy.resources.map((resource) => ({
      key: resource.resource.id,
      label: resource.resource.title,
      sublabel: resource.resource.location,
      icon: <ObjectIcon type="calendar" className="size-4 text-fg-muted" />,
      working: [{ start: dayStart, end: dayEnd }],
      busy: resource.busy.map((item) => ({
        start: Date.parse(item.startsAt),
        end: Date.parse(item.endsAt),
        title: item.title,
      })),
    }))
    return [...personRows, ...resourceRows]
  })()

  const ticks = Array.from({ length: (DAY_TO - DAY_FROM) / 60 + 1 }, (_, index) => ({
    at: instantAt(date, DAY_FROM + index * 60, tz),
    label: `${String(DAY_FROM / 60 + index).padStart(2, '0')}:00`,
  }))

  const slotsOfDay = (found?.slots ?? [])
    .map((slot) => ({ start: Date.parse(slot.startsAt), end: Date.parse(slot.endsAt) }))
    .filter((slot) => wallOf(slot.start, tz).date === date)

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={t('calendar.findTime.title')} width="860px">
        <div className="flex flex-col gap-4">
          {onAttendeesChange || onResourcesChange ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {onAttendeesChange ? (
                <PeoplePicker
                  value={attendees}
                  onChange={onAttendeesChange}
                  exclude={[me.id]}
                  label={t('calendar.event.attendees')}
                />
              ) : null}
              {onResourcesChange ? (
                <div className="flex flex-col gap-1.5">
                  {resources.length > 0 ? (
                    <ul
                      className="flex flex-wrap gap-1.5"
                      aria-label={t('calendar.event.resources')}
                    >
                      {resources.map((resource) => (
                        <li
                          key={resource.id}
                          className="flex items-center gap-1 rounded-sm border border-line bg-surface-2 py-0.5 pl-2 pr-0.5 text-sm"
                        >
                          {resource.title}
                          <IconButton
                            size="sm"
                            label={t('calendar.event.removeResource', { name: resource.title })}
                            onClick={() =>
                              onResourcesChange(
                                resources
                                  .filter((item) => item.id !== resource.id)
                                  .map((item) => item.id),
                              )
                            }
                          >
                            <X className="size-3" aria-hidden />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Select
                    value=""
                    onValueChange={(id) =>
                      id && onResourcesChange([...resources.map((item) => item.id), id])
                    }
                  >
                    <SelectTrigger aria-label={t('calendar.event.addResource')}>
                      <SelectValue placeholder={t('calendar.event.addResource')} />
                    </SelectTrigger>
                    <SelectContent>
                      {resourceOptions
                        .filter((option) => !resources.some((item) => item.id === option.id))
                        .map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.title}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <IconButton
              label={t('calendar.previousDay')}
              variant="secondary"
              onClick={() => setDate(addDays(date, -1))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </IconButton>
            <label htmlFor={dateId} className="sr-only">
              {t('calendar.event.date')}
            </label>
            <Input
              id={dateId}
              type="date"
              value={date}
              onChange={(event) => event.target.value && setDate(event.target.value)}
              className="w-40"
            />
            <IconButton
              label={t('calendar.nextDay')}
              variant="secondary"
              onClick={() => setDate(addDays(date, 1))}
            >
              <ChevronRight className="size-4" aria-hidden />
            </IconButton>
            <span className="text-sm font-medium text-fg">{format.dayTitle(date)}</span>
            {freeBusy?.nonWorkingDays.includes(date) ? (
              <span className="text-xs text-danger">{t('calendar.findTime.nonWorking')}</span>
            ) : null}
            <span className="ml-auto flex items-center gap-3">
              <Select
                value={String(duration)}
                onValueChange={(value) => setDuration(Number(value))}
              >
                <SelectTrigger aria-label={t('calendar.findTime.duration')} className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {t('calendar.findTime.minutes', { count: minutes })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Switch
                checked={workingOnly}
                onCheckedChange={setWorkingOnly}
                label={t('calendar.findTime.workingHoursOnly')}
              />
            </span>
          </div>

          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <AvailabilityGrid
              aria-label={t('calendar.findTime.gridLabel', { date: format.dayTitle(date) })}
              start={dayStart}
              end={dayEnd}
              ticks={ticks}
              rows={rows}
              selection={selection}
              suggestions={slotsOfDay}
              formatRange={format.timeRange}
              onPick={(at) => {
                const step = 15 * MINUTE_MS
                const start = Math.round(at / step) * step
                onPick(start, start + duration * MINUTE_MS)
              }}
            />
          )}
          <p className="text-xs text-fg-muted">{t('calendar.findTime.hint')}</p>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-fg">{t('calendar.findTime.suggestions')}</h3>
            {searching && !found ? (
              <Skeleton className="h-16 w-full" />
            ) : !found?.slots.length ? (
              <EmptyState
                compact
                icon={<CalendarSearch />}
                title={t('calendar.findTime.noSlots')}
              />
            ) : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {found.slots.map((slot) => {
                  const start = Date.parse(slot.startsAt)
                  const end = Date.parse(slot.endsAt)
                  return (
                    <li key={slot.startsAt}>
                      <Button
                        variant="secondary"
                        block
                        className="h-auto justify-start py-1.5 text-left"
                        onClick={() => onPick(start, end)}
                      >
                        <span className="flex flex-col">
                          <span className="text-sm">
                            {format.dayTitle(wallOf(start, tz).date)},{' '}
                            {format.timeRange(start, end)}
                          </span>
                          {slot.optionalBusy > 0 ? (
                            <span className="text-2xs text-fg-muted">
                              {t('calendar.findTime.optionalBusy', { count: slot.optionalBusy })}
                            </span>
                          ) : null}
                        </span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
          {attendees.length === 0 && resources.length === 0 && !onAttendeesChange ? (
            <Callout tone="info">{t('calendar.findTime.addPeopleHint')}</Callout>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
