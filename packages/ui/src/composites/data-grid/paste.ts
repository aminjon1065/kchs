import { parseValue } from '@kchs/fields'
import type { Translator } from '@kchs/i18n'
import type { PasteTarget } from './clipboard.js'
import type { GridStatus } from './grid-footer.js'
import type { CellChange } from './history.js'
import type { RenderColumn } from './layout.js'
import type { DataGridRow } from './types.js'
import type { ValueContext } from './values.js'

/** Изменений за одну вставку или очистку — больше отправлять пакетом не стоит. */
export const MAX_BATCH = 5_000
/** Новых строк за одну вставку — столько же принимает вставка строк датасета. */
const MAX_APPEND = 1_000

/** Разбор вставки в существующие строки: изменения, нераспознанные и пропущенные значения. */
export interface PastePlan {
  changes: CellChange[]
  invalid: Array<{ text: string; col: RenderColumn; rowId: string }>
  skipped: number
  unchanged: number
  overflow: number
}

/**
 * Значения буфера по целевым ячейкам: только правимые столбцы загруженных строк,
 * не больше `MAX_BATCH` изменений за раз; значение, равное текущему, — не изменение.
 */
export function pasteChanges(
  targets: readonly PasteTarget[],
  columns: readonly RenderColumn[],
  getRow: (index: number) => DataGridRow | undefined,
  changeFor: (rowIndex: number, col: RenderColumn, value: unknown) => CellChange | null,
  ctx: ValueContext,
): PastePlan {
  const changes: CellChange[] = []
  const invalid: Array<{ text: string; col: RenderColumn; rowId: string }> = []
  let skipped = 0
  let unchanged = 0
  let overflow = 0
  for (const target of targets) {
    if (changes.length >= MAX_BATCH) {
      overflow += 1
      continue
    }
    const col = columns[target.col]
    const row = getRow(target.row)
    if (!col?.editor || !row) {
      skipped += 1
      continue
    }
    const parsed = parseValue(target.text, col.column, ctx)
    if (!parsed.ok) {
      invalid.push({ text: target.text, col, rowId: row.id })
      continue
    }
    const change = changeFor(target.row, col, parsed.value)
    if (change) changes.push(change)
    else unchanged += 1
  }
  return { changes, invalid, skipped, unchanged, overflow }
}

/** Отчёт о вставке в подвале: сколько вставлено, что не распознано, пропущено и не вошло. */
export function pasteReport(
  t: Translator,
  plan: PastePlan,
  targets: number,
  outside: number,
): GridStatus {
  const { changes, invalid, skipped, unchanged } = plan
  const parts = targets > 0 ? [t('ui.grid.pasted', { count: changes.length + unchanged })] : []
  if (invalid.length > 0) {
    const examples = invalid
      .slice(0, 3)
      .map((item) => t('ui.grid.pasteExample', { value: item.text, name: item.col.column.label }))
      .join(', ')
    parts.push(t('ui.grid.pasteInvalid', { count: invalid.length, examples }))
  }
  if (skipped > 0) parts.push(t('ui.grid.pasteSkipped', { count: skipped }))
  if (outside > 0) parts.push(t('ui.grid.pasteClipped', { count: outside }))
  return {
    tone: invalid.length > 0 || skipped > 0 ? 'danger' : 'info',
    text: parts.join(' · '),
  }
}

/**
 * Строки вставки ниже последней — значения по столбцам, начиная со `startCol`:
 * пустые и только для чтения пропускаются, строка заголовков отбрасывается.
 * Первое нераспознанное значение останавливает добавление целиком.
 */
export function rowsToAppend(
  lines: string[][],
  startCol: number,
  columns: readonly RenderColumn[],
  ctx: ValueContext,
) {
  const columnAt = (offset: number) => columns[startCol + offset]
  const header = (cells: string[]) =>
    cells.length > 0 &&
    cells.every(
      (text, offset) =>
        text.trim().toLowerCase() === columnAt(offset)?.column.label.trim().toLowerCase(),
    )
  const data = lines.length > 0 && header(lines[0] ?? []) ? lines.slice(1) : lines
  const rows: Array<Record<string, unknown>> = []
  for (const [index, cells] of data.slice(0, MAX_APPEND).entries()) {
    const values: Record<string, unknown> = {}
    for (const [offset, text] of cells.entries()) {
      const col = columnAt(offset)
      if (!col?.editor || text.trim() === '') continue
      const parsed = parseValue(text, col.column, ctx)
      if (!parsed.ok) return { rows, overflow: 0, invalid: { row: index, text, col } }
      values[col.key] = parsed.value
    }
    if (Object.keys(values).length > 0) rows.push(values)
  }
  const overflow = data.slice(MAX_APPEND).reduce((sum, cells) => sum + cells.length, 0)
  return { rows, overflow, invalid: null }
}
