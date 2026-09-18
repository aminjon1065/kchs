import type { FieldDef, FieldType, Locale } from '@kchs/contracts'
import { zonedDateTime } from './ranges.js'

/**
 * Разбор значений, набранных или вставленных человеком (DataGrid, формы,
 * мастер импорта): «12 345,6», «01.02.2026», «да». Результат — значение в
 * каноническом виде хранения (contracts/field-types.md): число, строка
 * `YYYY-MM-DD`, ISO-время, логическое.
 */
export type ParseResult = { ok: true; value: unknown } | { ok: false }

export interface ParseContext {
  locale?: Locale
  /** Часовой пояс для даты-времени без смещения. */
  timezone?: string
}

const DEFAULT_TIMEZONE = 'Asia/Dushanbe'

/** Пробелы всех видов и апостроф — разделители тысяч. */
const GROUP_SEPARATORS = /[\s   ']/g
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/**
 * Число из текста с учётом локали: `12 345,6` и `12,345.6` дают 12345.6.
 * Если есть и запятая, и точка, десятичный знак — последний. Одна запятая:
 * в ru/tg — десятичная, в en — тысячи, если за ней ровно три цифры.
 */
export function parseNumber(text: string, locale: Locale = 'ru'): number | null {
  let source = text.trim().replace(/−/g, '-').replace(GROUP_SEPARATORS, '')
  if (!source) return null
  const comma = source.lastIndexOf(',')
  const dot = source.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.'
    const group = decimal === ',' ? '.' : ','
    source = source.split(group).join('').replace(decimal, '.')
  } else if (comma >= 0) {
    const commas = source.split(',').length - 1
    const tail = source.length - comma - 1
    if (commas > 1 || (locale === 'en' && tail === 3)) source = source.split(',').join('')
    else source = source.replace(',', '.')
  } else if (dot >= 0 && source.split('.').length - 1 > 1) {
    // «1.234.567» — точки разделяют тысячи
    source = source.split('.').join('')
  }
  if (!PLAIN_NUMBER.test(source)) return null
  const value = Number(source)
  return Number.isFinite(value) ? value : null
}

export function parseInteger(text: string, locale: Locale = 'ru'): number | null {
  const value = parseNumber(text, locale)
  return value !== null && Number.isSafeInteger(value) ? value : null
}

const TRUE_WORDS = new Set(['true', '1', 'да', 'д', 'yes', 'y', 'on', '+', 'истина', 'ҳа', '✓'])
const FALSE_WORDS = new Set(['false', '0', 'нет', 'н', 'no', 'n', 'off', '-', 'ложь', 'не'])

export function parseBoolean(text: string): boolean | null {
  const word = text.trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return null
}

const pad = (value: number) => String(value).padStart(2, '0')

function validDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= days
}

/** Двузначный год: 00–69 → 2000-е, 70–99 → 1900-е (как в электронных таблицах). */
function fullYear(text: string): number {
  const year = Number(text)
  if (text.length > 2) return year
  return year < 70 ? 2000 + year : 1900 + year
}

interface DateParts {
  year: number
  month: number
  day: number
  rest: string
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/
const LOCAL_DATE = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)(.*)$/

function dateParts(text: string, locale: Locale): DateParts | null {
  const source = text.trim()
  const iso = ISO_DATE.exec(source)
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), rest: iso[4] ?? '' }
  }
  const local = LOCAL_DATE.exec(source)
  if (!local) return null
  const first = Number(local[1])
  const second = Number(local[3])
  // «01/02/2026» в en — месяц первым; точка и дефис — всегда день первым
  const monthFirst = local[2] === '/' && locale === 'en'
  return {
    year: fullYear(local[4] as string),
    month: monthFirst ? first : second,
    day: monthFirst ? second : first,
    rest: local[5] ?? '',
  }
}

/** Дата `YYYY-MM-DD` из «01.02.2026», «2026-02-01», «1/2/26» (en — месяц первым). */
export function parseDate(text: string, locale: Locale = 'ru'): string | null {
  const parts = dateParts(text, locale)
  if (!parts || !validDay(parts.year, parts.month, parts.day)) return null
  // Хвост допустим только у времени: «2026-02-01T10:00:00Z», «01.02.2026, 14:30» — берём дату
  if (parts.rest && !/^(T|,?\s+)\d{1,2}:\d{2}/i.test(parts.rest)) return null
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?)?$/i

/** Время `HH:MM:SS` из «9:30», «09:30:15», «2:30 PM». */
export function parseTime(text: string): string | null {
  const match = TIME.exec(text.trim())
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] ?? 0)
  const meridiem = match[4]?.toLowerCase()
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0)
  }
  if (hour > 23 || minute > 59 || second > 59) return null
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`
}

const OFFSET_TAIL = /([+-]\d{2}:?\d{2}|Z)$/i

/**
 * Момент времени (ISO UTC) из «01.02.2026 14:30», «01.02.2026, 14:30» (так
 * форматирует Intl), «2026-02-01T14:30:00+05:00». Без смещения — местное
 * время часового пояса контекста.
 */
export function parseDateTime(text: string, ctx: ParseContext = {}): string | null {
  const source = text.trim()
  const parts = dateParts(source, ctx.locale ?? 'ru')
  if (!parts || !validDay(parts.year, parts.month, parts.day)) return null
  const rest = parts.rest.trim().replace(/^(T|,\s*)/i, '')
  if (!rest) {
    const midnight = zonedDateTime(parts.year, parts.month, parts.day, 0, 0, 0, tz(ctx))
    return midnight.toISOString()
  }
  if (OFFSET_TAIL.test(rest) && ISO_DATE.test(source)) {
    const date = new Date(source.replace(' ', 'T'))
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const time = parseTime(rest)
  if (!time) return null
  const [hour, minute, second] = time.split(':').map(Number) as [number, number, number]
  return zonedDateTime(
    parts.year,
    parts.month,
    parts.day,
    hour,
    minute,
    second,
    tz(ctx),
  ).toISOString()
}

function tz(ctx: ParseContext): string {
  return ctx.timezone ?? DEFAULT_TIMEZONE
}

/** Вариант выбора по значению или подписи на любом языке, без учёта регистра. */
function matchOption(text: string, options: NonNullable<FieldDef['options']>): string | null {
  const needle = text.trim().toLowerCase()
  for (const option of options) {
    if (option.value.toLowerCase() === needle) return option.value
    const labels = [option.label.ru, option.label.tg, option.label.en]
    if (labels.some((label) => label?.trim().toLowerCase() === needle)) return option.value
  }
  return null
}

export type ParseTarget = Pick<FieldDef, 'type' | 'format' | 'options'>

/**
 * Значение поля из текста. Пустая строка — `null` (очистить значение).
 * Типы без текстового ввода (пользователь, геометрия, файл…) не разбираются.
 */
export function parseValue(text: string, field: ParseTarget, ctx: ParseContext = {}): ParseResult {
  const locale = ctx.locale ?? 'ru'
  if (text.trim() === '') return { ok: true, value: null }
  const ok = (value: unknown): ParseResult =>
    value === null || value === undefined ? { ok: false } : { ok: true, value }

  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'identifier':
    case 'url':
    case 'email':
    case 'phone':
      return { ok: true, value: text.replace(/\r\n?/g, '\n') }
    case 'integer':
    case 'duration':
      return ok(parseInteger(text, locale))
    case 'number':
    case 'decimal':
    case 'money':
      return ok(parseNumber(text, locale))
    case 'percent': {
      const hasSign = text.includes('%')
      const value = parseNumber(text.replace('%', ''), locale)
      if (value === null) return { ok: false }
      // Хранение — доля (по умолчанию) или проценты (`scale: 'percent'`)
      if (field.format?.scale === 'percent') return { ok: true, value }
      return { ok: true, value: hasSign ? value / 100 : value }
    }
    case 'boolean':
      return ok(parseBoolean(text))
    case 'date':
      return ok(parseDate(text, locale))
    case 'datetime':
      return ok(parseDateTime(text, ctx))
    case 'time':
      return ok(parseTime(text))
    case 'select':
      return field.options?.length
        ? ok(matchOption(text, field.options))
        : { ok: true, value: text.trim() }
    case 'multi_select': {
      const parts = text
        .split(/[;,]/)
        .map((part) => part.trim())
        .filter(Boolean)
      if (!field.options?.length) return { ok: true, value: parts }
      const values = parts.map((part) => matchOption(part, field.options ?? []))
      return values.every((value) => value !== null) ? { ok: true, value: values } : { ok: false }
    }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch {
        return { ok: false }
      }
    default:
      return { ok: false }
  }
}

/** Типы, значения которых вводятся текстом (правка в ячейке, вставка). */
export const TEXT_INPUT_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'text',
  'long_text',
  'identifier',
  'url',
  'email',
  'phone',
  'integer',
  'duration',
  'number',
  'decimal',
  'money',
  'percent',
  'boolean',
  'date',
  'datetime',
  'time',
  'select',
  'multi_select',
  'json',
])
