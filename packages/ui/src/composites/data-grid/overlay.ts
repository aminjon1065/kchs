/**
 * Правки поверх данных родителя. Таблица показывает новое значение сразу
 * (оптимистично) и держит его, пока родитель не передаст обновлённые данные;
 * отказ сервера откатывает ячейку к значению из данных.
 */
import type { DataGridRow } from './types.js'
import { sameValue } from './values.js'

export interface CellOverlay {
  rowId: string
  rowIndex: number
  key: string
  value: unknown
  /** Пакет правки: ответ применяется, только если ячейку с тех пор не правили снова. */
  token: object
  status: 'pending' | 'saved'
  /** Сколько раз родитель обновил данные после сохранения. */
  generation: number
}

export type OverlayMap = ReadonlyMap<string, CellOverlay>
/** Ячейки, правку которых сервер не принял или вставка не распознала: ключ ячейки → причина. */
export type ErrorMap = ReadonlyMap<string, string>

/** Ключ ячейки: длина ключа столбца впереди делает пару однозначной при любых символах. */
export function cellKey(rowId: string, key: string): string {
  return `${key.length}:${key}:${rowId}`
}

/** Значение ячейки с учётом неподтверждённой правки. */
export function cellValue(row: DataGridRow, key: string, overlay: OverlayMap): unknown {
  if (overlay.size > 0) {
    const entry = overlay.get(cellKey(row.id, key))
    if (entry) return entry.value
  }
  return row.values[key]
}

/**
 * Родитель передал новые данные: сохранённая правка больше не нужна, если
 * данные её уже отражают, строка не загружена или сместилась. Если данные не
 * догнали правку за два обновления (сервер нормализовал значение) — тоже снимается.
 */
export function settleOverlay(
  overlay: OverlayMap,
  getRow: (index: number) => DataGridRow | undefined,
): OverlayMap {
  if (overlay.size === 0) return overlay
  let next: Map<string, CellOverlay> | null = null
  for (const [key, entry] of overlay) {
    if (entry.status !== 'saved') continue
    next ??= new Map(overlay)
    const row = getRow(entry.rowIndex)
    const settled =
      !row ||
      row.id !== entry.rowId ||
      sameValue(row.values[entry.key], entry.value) ||
      entry.generation >= 1
    if (settled) next.delete(key)
    else next.set(key, { ...entry, generation: entry.generation + 1 })
  }
  return next ?? overlay
}

/** Карта без ключей перечисленных ячеек (та же карта, если их нет). */
export function withoutCells(
  map: ErrorMap,
  cells: ReadonlyArray<{ rowId: string; key: string }>,
): ErrorMap {
  if (map.size === 0) return map
  let next: Map<string, string> | null = null
  for (const cell of cells) {
    const key = cellKey(cell.rowId, cell.key)
    if (!map.has(key)) continue
    next ??= new Map(map)
    next.delete(key)
  }
  return next ?? map
}
