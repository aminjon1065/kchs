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
  const out = new Intl.NumberFormat(intlLocale(ctx.locale), options).format(value)
  return `${format.prefix ?? ''}${out}${format.suffix ?? ''}`
}

export function formatPercent(
  value: number,
  format: FieldFormat = {},
  ctx: FormatContext = {},
): string {
  const normalized = format.scale === 'percent' ? value / 100 : value
  return new Intl.NumberFormat(intlLocale(ctx.locale), {
    style: 'percent',
    minimumFractionDigits: format.precision ?? 1,
    maximumFractionDigits: format.precision ?? 1,
  }).format(normalized)
}

export function formatDate(value: string | Date, ctx: FormatContext = {}): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(intlLocale(ctx.locale), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: ctx.timezone,
  }).format(date)
}

export function formatDateTime(value: string | Date, ctx: FormatContext = {}): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(intlLocale(ctx.locale), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ctx.timezone,
  }).format(date)
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
