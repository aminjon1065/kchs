import type { FormDefinition } from '@kchs/contracts'

/**
 * Строки табличной сводки (ADR-0129): в датасет уходят только поля формы,
 * число строк — в границах формы, обязательные поля заполнены в каждой строке.
 * Проверка до записи даёт сообщение с номером строки таблицы, как её видит
 * заполняющий; значения по типам проверяет модуль «Данные» при записи.
 */

/** Пустое значение поля сводки: не заполнено. */
export const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

/** Только ключи схемы формы: лишние значения в датасет не попадают. */
export function pickFields(
  values: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (key in values) out[key] = values[key]
  return out
}

export type TableRowsCheck =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; message: string }

/**
 * Строки к сдаче: поля формы из каждой строки, либо первая ошибка. Пустая
 * таблица допустима, если форма разрешает ноль строк («записей не было»);
 * полностью пустая строка — ошибка: её легко оставить, забыв удалить.
 */
export function checkTableRows(
  definition: Pick<FormDefinition, 'fields' | 'table'>,
  rows: ReadonlyArray<Record<string, unknown>>,
): TableRowsCheck {
  const { minRows, maxRows } = definition.table
  if (rows.length > maxRows) {
    return { ok: false, message: `Строк в сводке больше, чем разрешает форма (${maxRows})` }
  }
  if (rows.length < minRows) {
    return { ok: false, message: `Строк в сводке меньше, чем требует форма (${minRows})` }
  }
  const keys = definition.fields.map((field) => field.key)
  const out: Array<Record<string, unknown>> = []
  for (const [index, row] of rows.entries()) {
    const values = pickFields(row, keys)
    if (keys.every((key) => isBlank(values[key]))) {
      return { ok: false, message: `Строка ${index + 1} не заполнена — заполните или удалите её` }
    }
    const missing = definition.fields.find((field) => field.required && isBlank(values[field.key]))
    if (missing) {
      return { ok: false, message: `Строка ${index + 1}: поле «${missing.key}» обязательно` }
    }
    out.push(values)
  }
  return { ok: true, rows: out }
}
