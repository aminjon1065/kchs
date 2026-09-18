/**
 * Буфер обмена DataGrid: TSV как у Excel и Google Таблиц — табуляция между
 * ячейками, перевод строки между строками; ячейка с табуляцией, переводом
 * строки или кавычкой — в кавычках, кавычки удваиваются.
 */
import type { CellPos, GridBounds, GridRange } from './selection.js'

function quote(cell: string): string {
  return /[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

export function toTsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((row) => row.map(quote).join('\t')).join('\n')
}

/** Разбор TSV: кавычки с переводами строк внутри, \r\n и завершающий перевод строки. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let atCellStart = true

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += char
      continue
    }
    if (char === '"' && atCellStart) {
      quoted = true
      atCellStart = false
      continue
    }
    if (char === '\t') {
      row.push(cell)
      cell = ''
      atCellStart = true
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      atCellStart = true
      continue
    }
    cell += char
    atCellStart = false
  }
  // Завершающий перевод строки (Excel добавляет его) — не пустая строка
  if (cell !== '' || row.length > 0 || !atCellStart) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

export interface PasteTarget extends CellPos {
  text: string
}

/**
 * Куда вставлять: блок с активной ячейки; одно значение при выделенном
 * диапазоне — во все его ячейки (заполнение). Выходящее за таблицу отбрасывается.
 */
export function pasteTargets(
  matrix: string[][],
  start: CellPos,
  range: GridRange | null,
  bounds: GridBounds,
): { targets: PasteTarget[]; clipped: number } {
  const targets: PasteTarget[] = []
  let clipped = 0
  const single = matrix.length === 1 && matrix[0]?.length === 1
  if (single && range && (range.bottom > range.top || range.right > range.left)) {
    const text = matrix[0]?.[0] ?? ''
    for (let row = range.top; row <= range.bottom; row++) {
      for (let col = range.left; col <= range.right; col++) targets.push({ row, col, text })
    }
    return { targets, clipped }
  }
  matrix.forEach((cells, dRow) => {
    cells.forEach((text, dCol) => {
      const row = start.row + dRow
      const col = start.col + dCol
      if (row >= bounds.rows || col >= bounds.cols) clipped += 1
      else targets.push({ row, col, text })
    })
  })
  return { targets, clipped }
}
