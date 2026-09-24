import type { FieldDef } from '@kchs/contracts'
import { validateValues } from '@kchs/fields'

/**
 * Строки табличной сводки на экране заполнения (ADR-0129) — чистые функции:
 * проверка ячеек тем же `validateValues`, что у `SchemaForm`, суммы «Итого» и
 * добавление строки в пределах формы.
 */

export type TableRow = Record<string, unknown>

/** Ошибки ячеек по ключу `строка:поле`. */
export type CellErrors = Record<string, string>

/** Числовые типы: у столбца считается сумма «Итого». */
const SUMMABLE = new Set(['integer', 'number', 'decimal', 'money'])

const isBlank = (value: unknown) => value === null || value === undefined || value === ''

/** Число значения ячейки: пустое и нечисловое в сумму не входят. */
function numberOf(value: unknown): number | null {
  if (isBlank(value)) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Проверка строк по схеме полей: корректные строки приводятся к типам (числа
 * из строк ввода), ошибки собираются по ячейкам; полностью пустая строка —
 * ошибка строки, а не молчаливый пропуск.
 */
export function validateRows(
  fields: readonly FieldDef[],
  rows: readonly TableRow[],
  messages: { required: string; invalid: string },
): { ok: true; rows: TableRow[] } | { ok: false; errors: CellErrors; rowErrors: number[] } {
  const errors: CellErrors = {}
  const rowErrors: number[] = []
  const out: TableRow[] = []
  for (const [index, row] of rows.entries()) {
    if (fields.every((field) => isBlank(row[field.key]))) {
      rowErrors.push(index)
      continue
    }
    const result = validateValues([...fields], row)
    if (result.ok) {
      out.push(result.data)
      continue
    }
    for (const issue of result.issues) {
      errors[`${index}:${issue.path}`] = isBlank(row[issue.path])
        ? messages.required
        : messages.invalid
    }
  }
  if (Object.keys(errors).length > 0 || rowErrors.length > 0) {
    return { ok: false, errors, rowErrors }
  }
  return { ok: true, rows: out }
}

/** Суммы «Итого» по столбцам: у числовых — сумма, у остальных — null. */
export function columnTotals(
  fields: readonly FieldDef[],
  rows: readonly TableRow[],
): Array<number | null> {
  return fields.map((field) =>
    SUMMABLE.has(field.type)
      ? rows.reduce((sum, row) => sum + (numberOf(row[field.key]) ?? 0), 0)
      : null,
  )
}

/** Добавить строку в конец таблицы — пустую, если строк меньше предела. */
export function withNewRow(rows: readonly TableRow[], maxRows: number): TableRow[] {
  return rows.length >= maxRows ? [...rows] : [...rows, {}]
}
