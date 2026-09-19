import { formatDate } from '@kchs/fields'
import { Field, Input, SegmentedControl } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { dueFromDate } from './task-status.js'

/** Срок в форме: дата или «N рабочих дней» по производственному календарю (ADR-0082). */
export interface DueValue {
  mode: 'date' | 'working'
  /** `ГГГГ-ММ-ДД` для режима даты. */
  date: string
  /** Число рабочих дней строкой — как в поле ввода. */
  days: string
}

export const emptyDue = (date = ''): DueValue => ({ mode: 'date', date, days: '' })

const workingDays = (value: DueValue): number | null => {
  if (value.days.trim() === '') return null
  const days = Number(value.days)
  return Number.isInteger(days) && days >= 0 && days <= 366 ? days : null
}

/** Заполнен ли срок. */
export const hasDue = (value: DueValue): boolean =>
  value.mode === 'date' ? value.date !== '' : workingDays(value) !== null

/** Поля запроса: `dueAt` — конец выбранного дня, или `dueWorkingDays`. */
export function dueFields(value: DueValue): { dueAt?: string; dueWorkingDays?: number } {
  if (value.mode === 'working') {
    const days = workingDays(value)
    return days === null ? {} : { dueWorkingDays: days }
  }
  return value.date ? { dueAt: dueFromDate(value.date) } : {}
}

/**
 * Срок поручения: дата или рабочие дни. Для рабочих дней сервер считает день
 * по производственному календарю (выходные и праздники пропускаются) — он же
 * показан подсказкой, чтобы человек видел итоговую дату до сохранения.
 */
export function DueInput({
  value,
  onChange,
  label,
  required,
  error,
}: {
  value: DueValue
  onChange: (value: DueValue) => void
  label: string
  required?: boolean
  error?: string | undefined
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const dateId = useId()
  const daysId = useId()
  const days = value.mode === 'working' ? workingDays(value) : null
  const { data: preview } = useQuery({
    queryKey: ['business-calendar', 'deadline', days],
    queryFn: () =>
      http.get<{ date: string; dueAt: string }>('/business-calendar/deadline', {
        query: { workingDays: days ?? 0 },
      }),
    enabled: days !== null,
    staleTime: 60_000,
  })

  return (
    <div className="flex flex-col gap-2">
      <SegmentedControl
        size="sm"
        aria-label={t('tasks.due.mode')}
        value={value.mode}
        onValueChange={(mode) => onChange({ ...value, mode })}
        options={[
          { value: 'date', label: t('tasks.due.date') },
          { value: 'working', label: t('tasks.due.workingDays') },
        ]}
      />
      {value.mode === 'date' ? (
        <Field label={label} htmlFor={dateId} error={error} required={required}>
          <Input
            id={dateId}
            type="date"
            value={value.date}
            onChange={(event) => onChange({ ...value, date: event.target.value })}
          />
        </Field>
      ) : (
        <Field
          label={t('tasks.due.workingDaysInput')}
          htmlFor={daysId}
          error={error}
          required={required}
          hint={
            preview && days !== null
              ? // Календарная дата срока: полдень этого дня по местным часам — та же дата в любом поясе
                t('tasks.due.preview', {
                  date: formatDate(`${preview.date}T12:00:00`, { locale }),
                })
              : t('tasks.due.workingDaysHint')
          }
        >
          <Input
            id={daysId}
            type="number"
            inputMode="numeric"
            min={0}
            max={366}
            value={value.days}
            onChange={(event) => onChange({ ...value, days: event.target.value })}
          />
        </Field>
      )}
    </div>
  )
}
