/**
 * Отмена и повтор правок (⌘Z / ⇧⌘Z): стек пакетов изменений. Пакет — одна
 * правка ячейки, вставка или очистка; отмена применяет обратный пакет через
 * `onEdit`, поэтому сервер остаётся источником правды.
 */

export interface CellChange {
  rowId: string
  rowIndex: number
  key: string
  previous: unknown
  value: unknown
}

export interface EditHistory {
  past: ReadonlyArray<ReadonlyArray<CellChange>>
  future: ReadonlyArray<ReadonlyArray<CellChange>>
}

export const EMPTY_HISTORY: EditHistory = { past: [], future: [] }

const LIMIT = 100

export function inverse(batch: ReadonlyArray<CellChange>): CellChange[] {
  return batch.map((change) => ({ ...change, previous: change.value, value: change.previous }))
}

/** Новая правка: в прошлое, будущее сбрасывается. */
export function recordEdit(history: EditHistory, batch: ReadonlyArray<CellChange>): EditHistory {
  if (batch.length === 0) return history
  return { past: [...history.past, batch].slice(-LIMIT), future: [] }
}

/** Что отменить: обратный пакет и состояние после успешного применения. */
export function planUndo(history: EditHistory): { apply: CellChange[]; next: EditHistory } | null {
  const last = history.past[history.past.length - 1]
  if (!last) return null
  return {
    apply: inverse(last),
    next: { past: history.past.slice(0, -1), future: [...history.future, last] },
  }
}

/**
 * Сервер не принял часть пакета: эти изменения убираются из истории,
 * чтобы отмена не отправляла значения, которых нет в данных.
 */
export function dropChanges(
  history: EditHistory,
  batch: ReadonlyArray<CellChange>,
  dropped: ReadonlySet<CellChange>,
): EditHistory {
  if (dropped.size === 0) return history
  const prune = (stack: EditHistory['past']) =>
    stack
      .map((item) => (item === batch ? item.filter((change) => !dropped.has(change)) : item))
      .filter((item) => item.length > 0)
  return { past: prune(history.past), future: prune(history.future) }
}

export function planRedo(history: EditHistory): { apply: CellChange[]; next: EditHistory } | null {
  const last = history.future[history.future.length - 1]
  if (!last) return null
  return {
    apply: [...last],
    next: { past: [...history.past, last], future: history.future.slice(0, -1) },
  }
}
