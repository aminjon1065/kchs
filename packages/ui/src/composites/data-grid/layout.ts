import type { DataGridColumn } from './types.js'
import { defaultWidth, type EditorKind } from './values.js'

/** Высота шапки, px — совпадает с классом `h-8` строки заголовков. */
export const HEADER_HEIGHT = 32
export const MIN_COLUMN_WIDTH = 56
export const MAX_COLUMN_WIDTH = 1200

/** Столбец в раскладке: позиция среди видимых, ширина и отступ слева в строке. */
export interface RenderColumn {
  key: string
  /** Позиция среди видимых столбцов (индекс столбца выделения). */
  index: number
  column: DataGridColumn
  width: number
  /** Отступ слева от начала строки (с учётом столбца номеров). */
  left: number
  pinned: boolean
  lastPinned: boolean
  numeric: boolean
  /** Как править; null — только чтение. */
  editor: EditorKind | null
}

export interface GridLayout {
  columns: RenderColumn[]
  pinnedCount: number
  /** Ширина столбца номеров строк. */
  gutter: number
  pinnedWidth: number
  totalWidth: number
}

/** Ширина столбца номеров: по числу цифр в последнем номере. */
export function gutterWidth(rowCount: number): number {
  const digits = String(Math.max(1, rowCount)).length
  return Math.max(44, 20 + digits * 8)
}

export function clampWidth(width: number, min = MIN_COLUMN_WIDTH): number {
  return Math.round(Math.max(min, Math.min(MAX_COLUMN_WIDTH, width)))
}

/**
 * Ширина столбца до ручной настройки: заданная или по типу поля, но не
 * уже подписи (≈7,5 px на символ шрифта шапки, отступы и значок сортировки).
 */
export function initialWidth(column: DataGridColumn): number {
  if (column.width) return clampWidth(column.width, column.minWidth)
  const byLabel = Math.min(260, Math.ceil(column.label.length * 7.5) + 48)
  return clampWidth(Math.max(defaultWidth(column.type), byLabel), column.minWidth)
}
