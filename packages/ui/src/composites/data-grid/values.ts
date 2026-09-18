import type { FieldDef, FieldType, Locale } from '@kchs/contracts'
import { formatDate, formatDateTime, formatValue, TEXT_INPUT_TYPES } from '@kchs/fields'

/** Что нужно знать о столбце для показа, копирования и правки значения. */
export type ValueColumn = Pick<FieldDef, 'type' | 'format' | 'options'>

export interface ValueContext {
  locale: Locale
  timezone?: string
}

const NUMERIC: ReadonlySet<FieldType> = new Set<FieldType>([
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
  'rollup',
])

export function isNumeric(type: FieldType): boolean {
  return NUMERIC.has(type)
}

/** Текст ячейки по типу (числа — табличными цифрами справа, даты — в локали). */
export function displayText(value: unknown, column: ValueColumn, ctx: ValueContext): string {
  if (value === null || value === undefined || value === '') return ''
  switch (column.type) {
    case 'json':
    case 'geometry':
      return typeof value === 'string' ? value : JSON.stringify(value)
    case 'time':
      return String(value).slice(0, 5)
    default:
      return formatValue(value, column, ctx)
  }
}

/**
 * Текст для буфера обмена: полная точность чисел с десятичным знаком локали,
 * даты в локали, подписи вариантов — чтобы вставка обратно (и в Excel)
 * давала то же значение.
 */
export function copyText(value: unknown, column: ValueColumn, ctx: ValueContext): string {
  if (value === null || value === undefined) return ''
  if (isNumeric(column.type)) {
    const text = String(value)
    return ctx.locale === 'en' ? text : text.replace('.', ',')
  }
  switch (column.type) {
    case 'date':
      return formatDate(String(value), ctx)
    case 'datetime':
      return formatDateTime(String(value), ctx)
    case 'boolean':
    case 'select':
    case 'multi_select':
      return formatValue(value, column, ctx)
    case 'json':
    case 'geometry':
      return typeof value === 'string' ? value : JSON.stringify(value)
    default:
      return String(value)
  }
}

/** Значение не изменилось: пустые равны между собой, объекты и списки — по содержимому. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const emptyA = a === null || a === undefined || a === ''
  const emptyB = b === null || b === undefined || b === ''
  if (emptyA || emptyB) return emptyA && emptyB
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/** Как править ячейку; null — только чтение (тип без текстового ввода). */
export type EditorKind = 'text' | 'number' | 'boolean' | 'select'

export function editorKind(type: FieldType): EditorKind | null {
  // Вычисляемые поля не правятся
  if (type === 'formula' || type === 'lookup' || type === 'rollup') return null
  if (type === 'boolean') return 'boolean'
  if (type === 'select') return 'select'
  if (isNumeric(type)) return 'number'
  return TEXT_INPUT_TYPES.has(type) ? 'text' : null
}

/** Текст значения в поле правки: без разделителей тысяч и с полной точностью. */
export function editText(value: unknown, column: ValueColumn, ctx: ValueContext): string {
  if (value === null || value === undefined) return ''
  if (column.type === 'select') return formatValue(value, column, ctx)
  return copyText(value, column, ctx)
}

/** Ширина по умолчанию по типу поля, px. */
export function defaultWidth(type: FieldType): number {
  if (isNumeric(type)) return 120
  switch (type) {
    case 'boolean':
      return 88
    case 'date':
    case 'time':
      return 112
    case 'datetime':
      return 152
    case 'long_text':
    case 'json':
      return 260
    case 'identifier':
      return 140
    default:
      return 180
  }
}
