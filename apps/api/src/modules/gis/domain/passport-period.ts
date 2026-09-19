import type { PassportPeriod, PassportWindow } from '@kchs/contracts'

type Relative = { unit: 'month' | 'year'; from: number; to: number }

/** Период паспорта: окна дат, условия относительного времени и месяцы искры. */
export interface PeriodPlan {
  window: PassportWindow | null
  previousWindow: PassportWindow | null
  /** Условие «текущий и предыдущий период» — один запрос на оба окна. */
  both: Relative | null
  current: Relative | null
  /** Начала месяцев текущего окна (`YYYY-MM-01`) — точки искры. */
  months: string[]
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Год и месяц (1…12) момента в поясе пользователя. */
function localMonth(now: Date, timezone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
  return { year: part('year'), month: part('month') }
}

/** Месяц со сдвигом: номер месяца от нулевого года. */
const monthIndex = (year: number, month: number) => year * 12 + (month - 1)
const monthStart = (index: number) => `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`
function monthEnd(index: number): string {
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${pad(month)}-${pad(days)}`
}

/**
 * Окна периода (ADR-0077): 12 месяцев до текущего включительно и 12 перед ними;
 * текущий год и прошлый; «всё время» — без окон и сравнения.
 */
export function periodPlan(period: PassportPeriod, now: Date, timezone: string): PeriodPlan {
  if (period === 'all') {
    return { window: null, previousWindow: null, both: null, current: null, months: [] }
  }
  const { year, month } = localMonth(now, timezone)
  const last = monthIndex(year, month)
  if (period === '12m') {
    const first = last - 11
    return {
      window: { from: monthStart(first), to: monthEnd(last) },
      previousWindow: { from: monthStart(first - 12), to: monthEnd(last - 12) },
      both: { unit: 'month', from: -23, to: 0 },
      current: { unit: 'month', from: -11, to: 0 },
      months: Array.from({ length: 12 }, (_, offset) => monthStart(first + offset)),
    }
  }
  const first = monthIndex(year, 1)
  return {
    window: { from: monthStart(first), to: monthEnd(first + 11) },
    previousWindow: { from: monthStart(first - 12), to: monthEnd(first - 1) },
    both: { unit: 'year', from: -1, to: 0 },
    current: { unit: 'year', from: 0, to: 0 },
    months: Array.from({ length: 12 }, (_, offset) => monthStart(first + offset)),
  }
}
