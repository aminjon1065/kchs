import { wallOf, weekdayOf } from './time.js'

/**
 * Повтор события в форме: пресеты («каждый день», «по будням», «каждую
 * неделю в этот день»…) и своё правило — в RRULE (RFC 5545) и обратно.
 * Сервер нормализует и проверяет правило; здесь — только понятная форма.
 */

export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
export type WeekdayCode = (typeof WEEKDAY_CODES)[number]
/** Порядок дней в форме — с понедельника. */
export const WEEK_ORDER: WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

export type RepeatFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export type RepeatEnd =
  | { kind: 'never' }
  | { kind: 'until'; date: string }
  | { kind: 'count'; count: number }

export interface RepeatRule {
  freq: RepeatFreq
  interval: number
  /** Дни недели (еженедельно) или «n-й день недели» месяца (`3TU`, `-1FR`). */
  byDay: string[]
  byMonthDay: number | null
  end: RepeatEnd
}

export const REPEAT_PRESETS = [
  'none',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'monthlyNth',
  'yearly',
  'custom',
] as const
export type RepeatPreset = (typeof REPEAT_PRESETS)[number]

const WORKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR']

/** Разбор RRULE; UNTIL — дата в поясе пользователя. */
export function parseRule(rrule: string | null, timezone: string): RepeatRule | null {
  if (!rrule) return null
  const parts = new Map(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((chunk) => chunk.split('=') as [string, string]),
  )
  const freq = parts.get('FREQ') as RepeatFreq | undefined
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null
  const until = parts.get('UNTIL')
  const count = parts.get('COUNT')
  let end: RepeatEnd = { kind: 'never' }
  if (until) {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(until)
    if (match) {
      const [, y, m, d, hh, mm, ss] = match
      end = hh
        ? {
            kind: 'until',
            date: wallOf(Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`), timezone).date,
          }
        : { kind: 'until', date: `${y}-${m}-${d}` }
    }
  } else if (count) {
    end = { kind: 'count', count: Number(count) }
  }
  return {
    freq,
    interval: Number(parts.get('INTERVAL') ?? 1) || 1,
    byDay: (parts.get('BYDAY') ?? '').split(',').filter(Boolean),
    byMonthDay: parts.has('BYMONTHDAY') ? Number(parts.get('BYMONTHDAY')) : null,
    end,
  }
}

export function buildRule(rule: RepeatRule): string {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byMonthDay !== null) parts.push(`BYMONTHDAY=${rule.byMonthDay}`)
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.join(',')}`)
  if (rule.end.kind === 'count') parts.push(`COUNT=${rule.end.count}`)
  if (rule.end.kind === 'until') parts.push(`UNTIL=${rule.end.date.replaceAll('-', '')}`)
  return parts.join(';')
}

/** Какой по счёту это день недели в месяце: 1…4 или -1 (последний). */
export function nthWeekday(date: string): { nth: number; day: WeekdayCode } {
  const day = WEEKDAY_CODES[weekdayOf(date)] ?? 'MO'
  const dayOfMonth = Number(date.slice(8))
  const nth = Math.ceil(dayOfMonth / 7)
  const [year, month] = date.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year ?? 1970, month ?? 1, 0)).getUTCDate()
  return { nth: dayOfMonth + 7 > lastDay ? -1 : nth, day }
}

export function presetRule(preset: RepeatPreset, startDate: string): RepeatRule | null {
  const weekday = WEEKDAY_CODES[weekdayOf(startDate)] ?? 'MO'
  const base = { interval: 1, byDay: [], byMonthDay: null, end: { kind: 'never' as const } }
  switch (preset) {
    case 'daily':
      return { ...base, freq: 'DAILY' }
    case 'weekdays':
      return { ...base, freq: 'WEEKLY', byDay: WORKDAYS }
    case 'weekly':
      return { ...base, freq: 'WEEKLY', byDay: [weekday] }
    case 'monthly':
      return { ...base, freq: 'MONTHLY', byMonthDay: Number(startDate.slice(8)) }
    case 'monthlyNth': {
      const { nth, day } = nthWeekday(startDate)
      return { ...base, freq: 'MONTHLY', byDay: [`${nth}${day}`] }
    }
    case 'yearly':
      return { ...base, freq: 'YEARLY' }
    default:
      return null
  }
}

/** Пресет, которому соответствует правило (иначе — «своё»). */
export function presetOf(rule: RepeatRule | null, startDate: string): RepeatPreset {
  if (!rule) return 'none'
  if (rule.end.kind !== 'never' || rule.interval !== 1) return 'custom'
  for (const preset of [
    'daily',
    'weekdays',
    'weekly',
    'monthly',
    'monthlyNth',
    'yearly',
  ] as const) {
    const candidate = presetRule(preset, startDate)
    if (candidate && buildRule(candidate) === buildRule(rule)) return preset
  }
  return 'custom'
}

/** Короткие названия дней недели по коду (для подписей). */
export function weekdayName(code: string, locale: string): string {
  const index = WEEKDAY_CODES.indexOf(code as WeekdayCode)
  // 4 января 2026 — воскресенье
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 0, 4 + Math.max(0, index))),
  )
}

/** Понятная подпись правила: «Каждую неделю: пн, ср; 10 раз». */
export function describeRule(
  rule: RepeatRule | null,
  t: (key: string, params?: Record<string, string | number>) => string,
  intlLocale: string,
  formatDate: (date: string) => string,
): string {
  if (!rule) return t('calendar.repeat.none')
  const days = rule.byDay
    .filter((code) => /^[A-Z]{2}$/.test(code))
    .sort((a, b) => WEEK_ORDER.indexOf(a as WeekdayCode) - WEEK_ORDER.indexOf(b as WeekdayCode))
  let text: string
  switch (rule.freq) {
    case 'DAILY':
      text = t('calendar.repeat.describe.daily', { count: rule.interval })
      break
    case 'WEEKLY':
      text =
        rule.interval === 1 && days.join() === WORKDAYS.join()
          ? t('calendar.repeat.describe.weekdays')
          : t('calendar.repeat.describe.weekly', {
              count: rule.interval,
              days: days.map((code) => weekdayName(code, intlLocale)).join(', '),
            })
      break
    case 'MONTHLY': {
      const nth = /^(-?\d)([A-Z]{2})$/.exec(rule.byDay[0] ?? '')
      text = nth
        ? t(
            nth[1] === '-1'
              ? 'calendar.repeat.describe.monthlyLast'
              : 'calendar.repeat.describe.monthlyNth',
            {
              count: rule.interval,
              nth: Number(nth[1]),
              day: weekdayName(nth[2] ?? 'MO', intlLocale),
            },
          )
        : t('calendar.repeat.describe.monthly', {
            count: rule.interval,
            day: rule.byMonthDay ?? 1,
          })
      break
    }
    default:
      text = t('calendar.repeat.describe.yearly', { count: rule.interval })
  }
  if (rule.end.kind === 'until') {
    text += t('calendar.repeat.describe.until', { date: formatDate(rule.end.date) })
  } else if (rule.end.kind === 'count') {
    text += t('calendar.repeat.describe.times', { count: rule.end.count })
  }
  return text
}
