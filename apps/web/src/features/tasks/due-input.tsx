import { formatDate } from '@kchs/fields'
import { Field, Input, SegmentedControl } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { type DueValue, workingDays } from './due-value.js'
import { tasksApi } from './queries.js'

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
  const locale = useLocale()
  const dateId = useId()
  const daysId = useId()
  const days = value.mode === 'working' ? workingDays(value) : null
  const { data: preview } = useQuery({
    queryKey: ['business-calendar', 'deadline', days],
    queryFn: () => tasksApi.getBusinessCalendarDeadline({ workingDays: days ?? 0 }),
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
