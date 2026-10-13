import type { KeyboardEvent } from 'react'
import { type GridLayout, HEADER_HEIGHT } from './layout.js'
import {
  type CellPos,
  EMPTY_SELECTION,
  type GridBounds,
  isMultiple,
  moveBy,
  moveToEdge,
  rangeOf,
  type SelectionState,
  selectAll,
  selectCell,
  selectRow,
  tabMove,
} from './selection.js'
import type { DataGridRow } from './types.js'

/** Что клавиатуре таблицы нужно от неё самой: состояние и действия. */
export interface GridKeyboardApi {
  bounds: GridBounds
  selection: SelectionState
  layout: GridLayout
  editable: boolean
  rowHeight: number
  /** Высота видимой части таблицы — для PageUp и PageDown. */
  viewportHeight: () => number
  getRow: (index: number) => DataGridRow | undefined
  select: (next: SelectionState) => void
  setSelection: (next: SelectionState) => void
  openMenu: (col: number) => void
  startEditing: (pos: CellPos, seed: string | null) => boolean
  explainReadOnly: (pos: CellPos) => void
  toggleBoolean: (pos: CellPos) => void
  onRowOpen?: (row: DataGridRow, index: number) => void
  onRowPreview?: (row: DataGridRow, index: number) => void
  /** Escape: снять режим добавления строк и сообщение подвала с ошибками ячеек. */
  dismiss: () => void
  clearSelected: () => void
  undo: () => void
  redo: () => void
  routeClipboard: (kind: 'copy' | 'cut' | 'paste') => void
}

/**
 * Клавиатура таблицы как в электронных таблицах: стрелки и края, Tab, Enter и F2 —
 * правка, пробел — флажок или просмотр строки, Delete — очистка, ⌘Z/⌘⇧Z — отмена и
 * повтор, ⌘C/⌘X/⌘V — буфер обмена, печатный символ начинает правку.
 */
export function handleGridKey(event: KeyboardEvent<HTMLDivElement>, api: GridKeyboardApi): void {
  const {
    bounds,
    selection,
    layout,
    editable,
    rowHeight,
    getRow,
    select,
    setSelection,
    openMenu,
    startEditing,
    explainReadOnly,
    toggleBoolean,
    onRowOpen,
    onRowPreview,
    clearSelected,
    undo,
    redo,
    routeClipboard,
  } = api
  // События из поля правки, меню и других вложенных элементов таблица не трогает
  if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return
  if (bounds.rows === 0 || bounds.cols === 0) return
  const mod = event.metaKey || event.ctrlKey
  const shift = event.shiftKey
  const active = selection.active
  const handled = () => {
    event.preventDefault()
    event.stopPropagation()
  }

  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (event.altKey) {
        if (event.key === 'ArrowDown' && active) {
          handled()
          openMenu(active.col)
        }
        return
      }
      handled()
      const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp'
      const sign = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
      if (selection.rows && vertical && shift && active) {
        select(selectRow(selection, active.row + sign, bounds, 'extend'))
      } else if (mod) {
        const edge = vertical
          ? sign > 0
            ? 'colEnd'
            : 'colStart'
          : sign > 0
            ? 'rowEnd'
            : 'rowStart'
        select(moveToEdge(selection, edge, bounds, shift))
      } else {
        select(moveBy(selection, vertical ? sign : 0, vertical ? 0 : sign, bounds, shift))
      }
      return
    }
    case 'Home':
    case 'End': {
      handled()
      const end = event.key === 'End'
      const edge = mod ? (end ? 'gridEnd' : 'gridStart') : end ? 'rowEnd' : 'rowStart'
      select(moveToEdge(selection, edge, bounds, shift))
      return
    }
    case 'PageDown':
    case 'PageUp': {
      handled()
      const viewport = api.viewportHeight() - HEADER_HEIGHT
      const page = Math.max(1, Math.floor(viewport / rowHeight) - 1)
      select(moveBy(selection, event.key === 'PageDown' ? page : -page, 0, bounds, shift))
      return
    }
    case 'Tab': {
      if (mod || event.altKey) return
      const next = tabMove(selection, shift, bounds)
      // На краю таблицы Tab уводит фокус дальше по странице
      if (next === selection) return
      handled()
      select(next)
      return
    }
    case 'Enter': {
      if (!active || mod || event.altKey) return
      handled()
      if (startEditing(active, null)) return
      const row = getRow(active.row)
      if (row && onRowOpen) onRowOpen(row, active.row)
      else explainReadOnly(active)
      return
    }
    case 'F2':
      if (active) {
        handled()
        if (!startEditing(active, null)) explainReadOnly(active)
      }
      return
    case ' ': {
      if (!active || mod) return
      handled()
      if (shift) {
        // Shift+Пробел — строки текущего диапазона целиком
        const current = rangeOf(selection)
        const top = current ? current.top : active.row
        const bottom = current ? current.bottom : active.row
        const anchor = { row: active.row === top ? bottom : top, col: active.col }
        setSelection({ active, anchor, rows: [[top, bottom]] })
        return
      }
      if (layout.columns[active.col]?.editor === 'boolean') {
        toggleBoolean(active)
        return
      }
      const row = getRow(active.row)
      if (row) onRowPreview?.(row, active.row)
      return
    }
    case 'Escape':
      api.dismiss()
      if (active && isMultiple(selection)) {
        handled()
        setSelection(selectCell(EMPTY_SELECTION, active, bounds))
      }
      return
    case 'Delete':
    case 'Backspace':
      if (!editable) return
      handled()
      clearSelected()
      return
    case 'ContextMenu':
      if (active) {
        handled()
        openMenu(active.col)
      }
      return
    case 'F10':
      if (shift && active) {
        handled()
        openMenu(active.col)
      }
      return
    default:
      break
  }

  if (mod && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'a') {
      handled()
      setSelection(selectAll(bounds))
    } else if (key === 'z' && editable) {
      handled()
      if (shift) redo()
      else undo()
    } else if (key === 'y' && event.ctrlKey && editable) {
      handled()
      redo()
    } else if (!shift && (key === 'c' || key === 'x' || key === 'v')) {
      // Без preventDefault: команду буфера выполнит браузер, но уже в скрытом поле
      routeClipboard(key === 'c' ? 'copy' : key === 'x' ? 'cut' : 'paste')
    }
    return
  }

  // Печатный символ начинает правку с этого символа
  if (active && event.key.length === 1 && !event.altKey) {
    const kind = layout.columns[active.col]?.editor
    if (kind && kind !== 'boolean') {
      handled()
      startEditing(active, event.key)
    } else if (!kind) explainReadOnly(active)
  }
}
