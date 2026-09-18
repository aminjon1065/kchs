/** BOM: Excel открывает UTF-8 с кириллицей без мастера импорта. */
export const CSV_BOM = '﻿'

/**
 * Ячейка CSV (RFC 4180). Значения, которые табличный редактор принял бы за
 * формулу (=, +, -, @, табуляция), экранируются апострофом — защита от
 * CSV-инъекций при открытии выгрузки в Excel.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Строка CSV с разделителем строк Excel. */
export function csvLine(values: Array<string | number | null | undefined>): string {
  return `${values.map((value) => csvCell(value === null || value === undefined ? '' : String(value))).join(',')}\r\n`
}
