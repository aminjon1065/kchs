import {
  CALENDAR_COLORS,
  type CalendarColor,
  type Reminder,
  type ReminderChannel,
} from '@kchs/contracts'
import {
  Button,
  CalendarColorPicker,
  Checkbox,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { Bell, Plus, X } from 'lucide-react'
import { useId } from 'react'
import { useT } from '~/shared/i18n.js'
import { useCalendarFormat } from './format.js'
import { nthWeekday, type RepeatRule, WEEK_ORDER, weekdayName } from './recurrence.js'
import { addDays } from './time.js'

/** Поля формы события и календаря: дата и время, свой повтор, напоминания, цвет. */

const REMINDER_MINUTES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880]
const CHANNELS: ReminderChannel[] = ['app', 'email', 'telegram', 'push']

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

export function DateTimeInput({
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

export function CustomRepeat({
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
