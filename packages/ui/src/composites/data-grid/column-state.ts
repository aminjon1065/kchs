import { useCallback, useMemo, useState } from 'react'
import type { DataGridColumn, DataGridColumnState } from './types.js'

/**
 * Раскладка столбцов с учётом добавленных и удалённых полей: неизвестные
 * ключи отбрасываются, новые столбцы — в конец порядка.
 */
export function reconcileColumnState(
  columns: DataGridColumn[],
  state: Partial<DataGridColumnState> | undefined,
): DataGridColumnState {
  const keys = new Set(columns.map((column) => column.key))
  const order = (state?.order ?? []).filter((key) => keys.has(key))
  for (const column of columns) if (!order.includes(column.key)) order.push(column.key)
  const widths: Record<string, number> = {}
  for (const [key, width] of Object.entries(state?.widths ?? {})) {
    if (keys.has(key) && Number.isFinite(width)) widths[key] = width
  }
  return {
    order,
    widths,
    hidden: (state?.hidden ?? []).filter((key) => keys.has(key)),
    pinned: (state?.pinned ?? []).filter((key) => keys.has(key)),
  }
}

/**
 * Раскладка, которую хранит родитель: нужна, когда рядом с таблицей стоит
 * кнопка «Столбцы» или раскладка сохраняется в представлении.
 */
export function useDataGridColumnState(
  columns: DataGridColumn[],
  initial?: Partial<DataGridColumnState>,
): [DataGridColumnState, (next: DataGridColumnState) => void] {
  const [stored, setStored] = useState<Partial<DataGridColumnState> | undefined>(initial)
  const state = useMemo(() => reconcileColumnState(columns, stored), [columns, stored])
  const update = useCallback((next: DataGridColumnState) => setStored(next), [])
  return [state, update]
}
