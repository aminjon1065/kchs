import type { FieldDef, FieldFormat, FieldType, Locale } from '@kchs/contracts'

const DEFAULT_LOCALE: Locale = 'ru'

/** Соответствие локалей платформы кодам Intl. */
const INTL_LOCALE: Record<Locale, string> = { ru: 'ru-RU', tg: 'tg-TJ', en: 'en-US' }

export interface FormatContext {
  locale?: Locale
  timezone?: string
}

function intlLocale(locale: Locale = DEFAULT_LOCALE): string {
  return INTL_LOCALE[locale] ?? 'ru-RU'
}

// Создание форматтера Intl на порядок дороже форматирования: таблица на
// 100 столбцов форматирует тысячи ячеек за кадр, поэтому форматтеры кэшируются
const numberFormatters = new Map<string, Intl.NumberFormat>()
const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function numberFormatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${options.style ?? ''}|${options.currency ?? ''}|${String(options.useGrouping)}|${options.minimumFractionDigits ?? ''}|${options.maximumFractionDigits ?? ''}`
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    numberFormatters.set(key, formatter)
  }
  return formatter
}

function dateFormatter(locale: string, withTime: boolean, timeZone?: string): Intl.DateTimeFormat {
  const key = `${locale}|${withTime ? 'dt' : 'd'}|${timeZone ?? ''}`
  let formatter = dateFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
      timeZone,
    })
    dateFormatters.set(key, formatter)
  }
  return formatter
}

export function formatNumber(
  value: number,
  format: FieldFormat = {},
  ctx: FormatContext = {},
): string {
  const options: Intl.NumberFormatOptions = {
    useGrouping: format.thousands !== false,
  }
  if (format.precision !== undefined) {
    options.minimumFractionDigits = format.precision
    options.maximumFractionDigits = format.precision
  } else {
    options.maximumFractionDigits = 3
  }
  if (format.currency) {
    options.style = 'currency'
    options.currency = format.currency
  }
  const out = numberFormatter(intlLocale(ctx.locale), options).format(value)
  return `${format.prefix ?? ''}${out}${format.suffix ?? ''}`
}

export function formatPercent(
  value: number,
  format: FieldFormat = {},
  ctx: FormatContext = {},
): string {
  const normalized = format.scale === 'percent' ? value / 100 : value
  return numberFormatter(intlLocale(ctx.locale), {
    style: 'percent',
    minimumFractionDigits: format.precision ?? 1,
    maximumFractionDigits: format.precision ?? 1,
  }).format(normalized)
}

export function formatDate(value: string | Date, ctx: FormatContext = {}): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  return dateFormatter(intlLocale(ctx.locale), false, ctx.timezone).format(date)
}

export function formatDateTime(value: string | Date, ctx: FormatContext = {}): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  return dateFormatter(intlLocale(ctx.locale), true, ctx.timezone).format(date)
}

/** Длительность в минутах → «1 ч 30 мин». */
export function formatDuration(minutes: number, ctx: FormatContext = {}): string {
  const locale = ctx.locale ?? DEFAULT_LOCALE
  const h = Math.floor(Math.abs(minutes) / 60)
  const m = Math.abs(minutes) % 60
  const units = locale === 'en' ? { h: 'h', m: 'min' } : { h: 'ч', m: 'мин' }
  const sign = minutes < 0 ? '−' : ''
  if (h === 0) return `${sign}${m} ${units.m}`
  if (m === 0) return `${sign}${h} ${units.h}`
  return `${sign}${h} ${units.h} ${m} ${units.m}`
}

export function formatFileSize(bytes: number, ctx: FormatContext = {}): string {
  const locale = ctx.locale ?? DEFAULT_LOCALE
  const units = locale === 'en' ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  const digits = i === 0 ? 0 : value < 10 ? 1 : 0
  return `${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: digits }).format(value)} ${units[i]}`
}

/** Универсальное форматирование значения по определению поля. */
export function formatValue(
  value: unknown,
  field: Pick<FieldDef, 'type' | 'format' | 'options'>,
  ctx: FormatContext = {},
): string {
  if (value === null || value === undefined || value === '') return ''
  const type = field.type as FieldType
  switch (type) {
    case 'integer':
    case 'number':
    case 'decimal':
    case 'money':
    case 'rollup':
      return formatNumber(Number(value), field.format ?? {}, ctx)
    case 'percent':
      return formatPercent(Number(value), field.format ?? {}, ctx)
    case 'duration':
      return formatDuration(Number(value), ctx)
    case 'boolean':
      return value ? (ctx.locale === 'en' ? 'Yes' : 'Да') : ctx.locale === 'en' ? 'No' : 'Нет'
    case 'date':
      return formatDate(String(value), ctx)
    case 'datetime':
      return formatDateTime(String(value), ctx)
    case 'select': {
      const option = field.options?.find((o) => o.value === value)
      if (!option) return String(value)
      return option.label[ctx.locale ?? DEFAULT_LOCALE] ?? option.label.ru
    }
    case 'multi_select': {
      const values = Array.isArray(value) ? value : [value]
      return values
        .map((v) => {
          const option = field.options?.find((o) => o.value === v)
          return option
            ? (option.label[ctx.locale ?? DEFAULT_LOCALE] ?? option.label.ru)
            : String(v)
        })
        .join(', ')
    }
    default:
      return String(value)
  }
}

/** Относительное время: «2 мин назад», «вчера». */
export function formatRelativeTime(value: string | Date, ctx: FormatContext = {}): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  const rtf = new Intl.RelativeTimeFormat(intlLocale(ctx.locale), { numeric: 'auto' })
  const diffMs = date.getTime() - Date.now()
  const abs = Math.abs(diffMs)
  const table: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 1000],
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
    ['week', 604_800_000],
    ['month', 2_592_000_000],
    ['year', 31_536_000_000],
  ]
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  let divisor = 1000
  for (const [u, d] of table) {
    if (abs >= d) {
      unit = u
      divisor = d
    }
  }
  return rtf.format(Math.round(diffMs / divisor), unit)
}

/**
 * Компактное число для осей графиков и плиток показателей: до порога — полностью
 * с разделителями разрядов (1 284), от порога — сокращённо (12,9 тыс., 4,2 млн).
 */
export function formatCompactNumber(
  value: number,
  ctx: FormatContext = {},
  options: { threshold?: number; format?: FieldFormat } = {},
): string {
  const threshold = options.threshold ?? 10_000
  const format = options.format ?? {}
  if (Math.abs(value) < threshold) return formatNumber(value, format, ctx)
  const out = new Intl.NumberFormat(intlLocale(ctx.locale), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
  return `${format.prefix ?? ''}${out}${format.suffix ?? ''}`
}

/** Гранулярность периода — бакеты агрегации QuerySpec. */
export type PeriodBucket = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour'

const ROMAN_QUARTERS = ['I', 'II', 'III', 'IV'] as const

/**
 * Подпись периода по бакету: «2026», «I кв. 2026», «янв. 2026», «12.03.2026».
 * Дата без времени — календарная (без сдвига поясом), момент времени — в поясе
 * платформы (`ctx.timezone`). `compact` убирает год у дней, месяцев и
 * кварталов и дату у часов — для подписей оси, где старший разряд виден рядом.
 */
export function formatPeriod(
  value: string | Date,
  bucket: PeriodBucket,
  ctx: FormatContext = {},
  options: { compact?: boolean } = {},
): string {
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  const timeZone = dateOnly ? 'UTC' : ctx.timezone
  const locale = intlLocale(ctx.locale)
  const part = (opts: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes) =>
    new Intl.DateTimeFormat(locale, { ...opts, timeZone })
      .formatToParts(date)
      .find((p) => p.type === type)?.value ?? ''
  const year = part({ year: 'numeric' }, 'year')

  switch (bucket) {
    case 'year':
      return year
    case 'quarter': {
      const quarter = Math.floor((Number(part({ month: 'numeric' }, 'month')) - 1) / 3)
      if (ctx.locale === 'en')
        return options.compact ? `Q${quarter + 1}` : `Q${quarter + 1} ${year}`
      const label = `${ROMAN_QUARTERS[quarter]} кв.`
      return options.compact ? label : `${label} ${year}`
    }
    case 'month': {
      const month = part({ month: 'short' }, 'month')
      return options.compact ? month : `${month} ${year}`
    }
    case 'week':
    case 'day':
      return new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: '2-digit',
        ...(options.compact ? {} : { year: 'numeric' }),
        timeZone,
      }).format(date)
    case 'hour':
      return new Intl.DateTimeFormat(locale, {
        ...(options.compact ? {} : { day: '2-digit', month: '2-digit' }),
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone,
      }).format(date)
  }
}
