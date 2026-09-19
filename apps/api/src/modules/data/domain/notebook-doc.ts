import {
  NOTEBOOK_CELL_LAYOUT,
  NOTEBOOK_DOC,
  NOTEBOOK_MAX_CELLS,
  NotebookCell,
  type NotebookCellKind,
  type NotebookParams,
  NotebookPeriod,
  type NotebookValueKind,
  type RichBody,
  WithinValue,
} from '@kchs/contracts'
import * as Y from 'yjs'
import { fragmentToRichBody, richBodyToFragment } from '~/kernel/collab/rich-text.js'

/**
 * Документ Yjs тетради ↔ JSON (ADR-0071): раскладка — в контракте
 * `NOTEBOOK_CELL_LAYOUT`, её же используют клиенты. Снимок читается из
 * документа, который пишут клиенты: ячейка, не прошедшая контракт, в снимок не
 * попадает, но и из документа не удаляется.
 */

/**
 * Клиент Yjs начального состояния: у всех процессов один и тот же, поэтому
 * одинаковый JSON даёт одинаковые операции и при слиянии не удваивается.
 */
const INITIAL_CLIENT_ID = 1

export interface NotebookBody {
  cells: NotebookCell[]
  params: NotebookParams
}

type Layout = Record<string, NotebookValueKind>

function layoutOf(kind: unknown): Layout | null {
  return typeof kind === 'string' && kind in NOTEBOOK_CELL_LAYOUT
    ? (NOTEBOOK_CELL_LAYOUT[kind as NotebookCellKind] as Layout)
    : null
}

/** Ячейка → `Y.Map` по раскладке её вида. */
function cellToYMap(cell: NotebookCell): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  const values = cell as unknown as Record<string, unknown>
  for (const [key, kind] of Object.entries(layoutOf(cell.kind) ?? {})) {
    const value = values[key]
    if (kind === 'rich') {
      const fragment = new Y.XmlFragment()
      richBodyToFragment((value as RichBody | undefined) ?? { type: 'doc', content: [] }, fragment)
      map.set(key, fragment)
    } else if (kind === 'text') {
      map.set(key, new Y.Text(typeof value === 'string' ? value : ''))
    } else if (value !== undefined) {
      map.set(key, value)
    }
  }
  return map
}

/**
 * Ячейки — в документ на позицию `index` (по умолчанию в конец). Занятый
 * идентификатор получает суффикс: ячейка не должна затереть другую, а
 * одинаковый вход — дать одинаковый документ.
 */
export function insertCells(doc: Y.Doc, cells: NotebookCell[], index?: number): void {
  const map = doc.getMap<Y.Map<unknown>>(NOTEBOOK_DOC.cells)
  const order = doc.getArray<string>(NOTEBOOK_DOC.order)
  const ids: string[] = []
  for (const cell of cells) {
    let id = cell.id
    for (let n = 2; map.has(id) || ids.includes(id); n++) id = `${cell.id.slice(0, 34)}-${n}`
    map.set(id, cellToYMap({ ...cell, id }))
    ids.push(id)
  }
  order.insert(Math.min(index ?? order.length, order.length), ids)
}

/** Начальное состояние документа из JSON — детерминированное (см. INITIAL_CLIENT_ID). */
export function notebookState(body: NotebookBody): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = INITIAL_CLIENT_ID
  doc.transact(() => {
    insertCells(doc, body.cells)
    const params = doc.getMap<unknown>(NOTEBOOK_DOC.params)
    params.set('period', body.params.period)
    params.set('territory', body.params.territory)
  })
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

/** Снимок документа: ячейки по порядку (повтор идентификатора — один раз) и параметры. */
export function readNotebook(doc: Y.Doc): NotebookBody {
  const map = doc.getMap<unknown>(NOTEBOOK_DOC.cells)
  const seen = new Set<string>()
  const cells: NotebookCell[] = []
  for (const id of doc.getArray<unknown>(NOTEBOOK_DOC.order).toArray()) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    const item = map.get(id)
    if (!(item instanceof Y.Map)) continue
    const cell = readCell(item, id)
    if (cell) cells.push(cell)
    if (cells.length >= NOTEBOOK_MAX_CELLS) break
  }
  const params = doc.getMap<unknown>(NOTEBOOK_DOC.params)
  const period = NotebookPeriod.nullable().safeParse(params.get('period') ?? null)
  const territory = WithinValue.nullable().safeParse(params.get('territory') ?? null)
  return {
    cells,
    params: {
      period: period.success ? period.data : null,
      territory: territory.success ? territory.data : null,
    },
  }
}

function readCell(item: Y.Map<unknown>, id: string): NotebookCell | null {
  const layout = layoutOf(item.get('kind'))
  if (!layout) return null
  const raw: Record<string, unknown> = {}
  for (const [key, kind] of Object.entries(layout)) {
    const value = item.get(key)
    if (kind === 'rich') {
      if (value instanceof Y.XmlFragment) raw[key] = fragmentToRichBody(value)
    } else if (kind === 'text') {
      if (value instanceof Y.Text) raw[key] = value.toString()
      else if (typeof value === 'string') raw[key] = value
    } else if (value !== undefined && !(value instanceof Y.AbstractType)) {
      raw[key] = value
    }
  }
  // Идентификатор — ключ в карте ячеек: поле ячейки могло разойтись с ним
  raw.id = id
  const parsed = NotebookCell.safeParse(raw)
  return parsed.success ? parsed.data : null
}
