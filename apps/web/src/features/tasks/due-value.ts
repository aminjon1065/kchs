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

/** Рабочие дни из поля ввода — или null, если число вне 0…366. */
export const workingDays = (value: DueValue): number | null => {
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
