import {
  NOTEBOOK_CELL_LAYOUT,
  NOTEBOOK_DOC,
  NOTEBOOK_MAX_CELLS,
  NotebookCell,
  type NotebookCellKind,
  type NotebookParams,
  NotebookPeriod,
  type NotebookValueKind,
  WithinValue,
} from '@kchs/contracts'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as Y from 'yjs'

/**
 * Документ Yjs тетради на клиенте (ADR-0071): раскладка — из контракта, как у
 * сервера. Все изменения — транзакциями документа: соавторы получают их
 * одним обновлением.
 */

export type CellMap = Y.Map<unknown>

/**
 * Корневые ключи документа: у тетради это `cells`/`order`, у страницы базы
 * знаний — `blocks`/`order` (ADR-0095). Функции работы с блоками одни и те же,
 * поэтому ключи передаются параметром, а не зашиты в них.
 */
export interface DocKeys {
  cells: string
  order: string
}

export const cellsOf = (doc: Y.Doc, keys: DocKeys = NOTEBOOK_DOC) => doc.getMap<CellMap>(keys.cells)
export const orderOf = (doc: Y.Doc, keys: DocKeys = NOTEBOOK_DOC) =>
  doc.getArray<string>(keys.order)
export const paramsOf = (doc: Y.Doc) => doc.getMap<unknown>(NOTEBOOK_DOC.params)

/** Идентификатор ячейки; getRandomValues работает и на странице без HTTPS (randomUUID — нет). */
export function newCellId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `c_${Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('')}`
}

/** Ячейки по порядку: повтор идентификатора (одновременный перенос) — один раз. */
export function cellIds(doc: Y.Doc, keys: DocKeys = NOTEBOOK_DOC): string[] {
  const cells = cellsOf(doc, keys)
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of orderOf(doc, keys).toArray()) {
    if (typeof id !== 'string' || seen.has(id) || !(cells.get(id) instanceof Y.Map)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** Новая ячейка вида: значения по умолчанию — из контракта. */
export function createCell(
  kind: NotebookCellKind,
  init: Record<string, unknown> = {},
): { id: string; map: CellMap } {
  const id = newCellId()
  const values = NotebookCell.parse({ ...init, id, kind }) as unknown as Record<string, unknown>
  const map = new Y.Map<unknown>()
  const layout = NOTEBOOK_CELL_LAYOUT[kind] as Record<string, NotebookValueKind>
  for (const [key, valueKind] of Object.entries(layout)) {
    const value = values[key]
    if (valueKind === 'rich') map.set(key, new Y.XmlFragment())
    else if (valueKind === 'text') map.set(key, new Y.Text(typeof value === 'string' ? value : ''))
    else if (value !== undefined) map.set(key, value)
  }
  return { id, map }
}

/** Запись в ячейку одной транзакцией документа: соавторы получают её целиком. */
export function writeCell(cell: CellMap, values: Record<string, unknown>): void {
  const apply = () => {
    for (const [key, value] of Object.entries(values)) cell.set(key, value)
  }
  if (cell.doc) cell.doc.transact(apply)
  else apply()
}

/** Ячейка на позицию в порядке; ячеек больше лимита не бывает. */
export function insertCell(
  doc: Y.Doc,
  cell: { id: string; map: CellMap },
  index: number,
  keys: DocKeys = NOTEBOOK_DOC,
): boolean {
  if (cellIds(doc, keys).length >= NOTEBOOK_MAX_CELLS) return false
  doc.transact(() => {
    cellsOf(doc, keys).set(cell.id, cell.map)
    const order = orderOf(doc, keys)
    order.insert(Math.max(0, Math.min(index, order.length)), [cell.id])
  })
  return true
}

/** Позиция ячейки в массиве порядка (первое вхождение). */
function positionOf(doc: Y.Doc, id: string, keys: DocKeys = NOTEBOOK_DOC): number {
  return orderOf(doc, keys).toArray().indexOf(id)
}

export function removeCell(doc: Y.Doc, id: string, keys: DocKeys = NOTEBOOK_DOC): void {
  doc.transact(() => {
    const order = orderOf(doc, keys)
    // Все вхождения: после одновременного переноса их может быть два
    for (let index = order.length - 1; index >= 0; index--) {
      if (order.get(index) === id) order.delete(index, 1)
    }
    cellsOf(doc, keys).delete(id)
  })
}

/** Перенос меняет только порядок: содержимое ячейки и правка в ней не трогаются. */
export function moveCell(
  doc: Y.Doc,
  id: string,
  delta: -1 | 1,
  keys: DocKeys = NOTEBOOK_DOC,
): void {
  const ids = cellIds(doc, keys)
  const from = ids.indexOf(id)
  const target = ids[from + delta]
  if (from < 0 || !target) return
  doc.transact(() => {
    const order = orderOf(doc, keys)
    const at = positionOf(doc, id, keys)
    if (at < 0) return
    order.delete(at, 1)
    const anchor = positionOf(doc, target, keys)
    order.insert(delta > 0 ? anchor + 1 : anchor, [id])
  })
}

/** Копия ячейки — сразу после неё. */
export function duplicateCell(doc: Y.Doc, id: string, keys: DocKeys = NOTEBOOK_DOC): string | null {
  const source = cellsOf(doc, keys).get(id)
  if (!(source instanceof Y.Map)) return null
  const copy = source.clone()
  const copyId = newCellId()
  copy.set('id', copyId)
  const at = positionOf(doc, id, keys)
  const index = at < 0 ? orderOf(doc, keys).length : at + 1
  return insertCell(doc, { id: copyId, map: copy }, index, keys) ? copyId : null
}

/** Параметры тетради: значение, не прошедшее контракт, — «не задан». */
export function readParams(doc: Y.Doc): NotebookParams {
  const params = paramsOf(doc)
  const period = NotebookPeriod.nullable().safeParse(params.get('period') ?? null)
  const territory = WithinValue.nullable().safeParse(params.get('territory') ?? null)
  return {
    period: period.success ? period.data : null,
    territory: territory.success ? territory.data : null,
  }
}

/**
 * Правка строки в `Y.Text` по разнице со старым значением: общие начало и
 * конец не трогаются — правки соавтора в другом месте строки сохраняются.
 */
export function applyTextChange(text: Y.Text, next: string): void {
  const current = text.toString()
  if (current === next) return
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let end = 0
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++
  }
  text.doc?.transact(() => {
    const removed = current.length - start - end
    if (removed > 0) text.delete(start, removed)
    const inserted = next.slice(start, next.length - end)
    if (inserted) text.insert(start, inserted)
  })
}

// ─── Подписки React ──────────────────────────────────────────────────────────

/**
 * Перерисовка по изменениям типа Yjs (`deep` — и вложенных): возвращает счётчик
 * изменений, которым удобно пересчитывать производные значения.
 */
export function useYChanges(
  type: Y.AbstractType<unknown> | null | undefined,
  deep = false,
): number {
  const version = useRef(0)
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!type) return () => undefined
      const handler = () => {
        version.current += 1
        notify()
      }
      if (deep) type.observeDeep(handler)
      else type.observe(handler)
      return () => {
        if (deep) type.unobserveDeep(handler)
        else type.unobserve(handler)
      }
    },
    [type, deep],
  )
  return useSyncExternalStore(subscribe, () => version.current)
}

/** Значение ключа ячейки (JSON): перерисовка — только когда меняется этот ключ. */
export function useCellValue<T>(cell: CellMap, key: string): T | undefined {
  const subscribe = useCallback(
    (notify: () => void) => {
      const handler = (event: Y.YMapEvent<unknown>) => {
        if (event.keysChanged.has(key)) notify()
      }
      cell.observe(handler)
      return () => cell.unobserve(handler)
    },
    [cell, key],
  )
  return useSyncExternalStore(subscribe, () => cell.get(key) as T | undefined)
}

/**
 * Строка `Y.Text` ячейки (SQL) для управляемого редактора: своя правка сразу
 * уходит в документ, а в редактор возвращаются только правки соавторов.
 * Эхо своей правки не перерисовывает редактор посреди его же обновления —
 * иначе быстрый набор упирался в предел вложенных обновлений React и терял
 * позицию курсора.
 */
export function useSharedText(text: Y.Text | undefined): [string, (next: string) => void] {
  const [value, setValue] = useState(() => text?.toString() ?? '')
  useEffect(() => {
    if (!text) return
    setValue(text.toString())
    const onRemote = (event: Y.YTextEvent) => {
      if (!event.transaction.local) setValue(text.toString())
    }
    text.observe(onRemote)
    return () => text.unobserve(onRemote)
  }, [text])
  const change = useCallback(
    (next: string) => {
      setValue(next)
      if (text) applyTextChange(text, next)
    },
    [text],
  )
  return [value, change]
}
