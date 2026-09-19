/**
 * Формат регистрационного номера журнала (08-documents.md §5, ADR-0080).
 *
 * Шаблон — текст с подстановками в фигурных скобках:
 *  - `{seq}` / `{seq:N}` — порядковый номер в журнале (N — ширина с нулями, 1…9), ровно один раз;
 *  - `{prefix}` — префикс журнала;
 *  - `{yy}`, `{yyyy}`, `{mm}` — год и месяц даты регистрации;
 *  - `{unit.code}` — индекс подразделения документа (без него — журнала).
 *
 * Чистые функции: сервер выдаёт номер, клиент показывает предпросмотр.
 */
export const DEFAULT_NUMBER_FORMAT = '{prefix}-{seq:04}/{yy}'

const TOKEN = /\{([a-z.]+)(?::(0?[1-9]))?\}/g
const KNOWN = new Set(['prefix', 'seq', 'yy', 'yyyy', 'mm', 'unit.code'])
const MAX_FORMAT = 64

export interface NumberParts {
  prefix: string
  sequence: number
  /** Дата регистрации (локальная дата организации) в виде YYYY-MM-DD. */
  date: string
  unitCode: string | null
}

export type NumberFormatIssue = 'empty' | 'too_long' | 'unknown_token' | 'no_seq' | 'many_seq'

/** Проверка шаблона: известные подстановки и ровно один `{seq}`. */
export function numberFormatIssue(format: string): NumberFormatIssue | null {
  if (format.trim() === '') return 'empty'
  if (format.length > MAX_FORMAT) return 'too_long'
  let seq = 0
  for (const match of format.matchAll(TOKEN)) {
    const name = match[1] ?? ''
    if (!KNOWN.has(name)) return 'unknown_token'
    if (match[2] !== undefined && name !== 'seq') return 'unknown_token'
    if (name === 'seq') seq += 1
  }
  // Незакрытые или пустые скобки — тоже неизвестная подстановка
  const rest = format.replace(TOKEN, '')
  if (rest.includes('{') || rest.includes('}')) return 'unknown_token'
  if (seq === 0) return 'no_seq'
  if (seq > 1) return 'many_seq'
  return null
}

/** Номер по шаблону. Шаблон проверен при сохранении журнала. */
export function formatRegNumber(format: string, parts: NumberParts): string {
  const [year = '0000', month = '01'] = parts.date.split('-')
  return format.replace(TOKEN, (_match, name: string, width: string | undefined) => {
    switch (name) {
      case 'seq':
        return width ? String(parts.sequence).padStart(Number(width), '0') : String(parts.sequence)
      case 'prefix':
        return parts.prefix
      case 'yy':
        return year.slice(-2)
      case 'yyyy':
        return year
      case 'mm':
        return month
      case 'unit.code':
        return parts.unitCode ?? ''
      default:
        return ''
    }
  })
}

/** Год счётчика: сброс по году — год даты регистрации, «никогда» — общий счётчик 0. */
export function counterYear(reset: 'year' | 'never', date: string): number {
  return reset === 'year' ? Number(date.slice(0, 4)) : 0
}
