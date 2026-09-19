import {
  NOTEBOOK_CELL_LAYOUT,
  NOTEBOOK_DOC,
  NOTEBOOK_MAX_CELLS,
  NotebookCell,
  type NotebookCellKind,
  type NotebookParams,
  NotebookPeriod,
  WithinValue,
} from '@kchs/contracts'
import * as Y from 'yjs'
import { type BlockDocDefinition, insertBlocks, readBlocks } from '~/kernel/collab/block-doc.js'

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

const CELLS: BlockDocDefinition = {
  blocks: NOTEBOOK_DOC.cells,
  order: NOTEBOOK_DOC.order,
  layoutOf: (kind) =>
    typeof kind === 'string' && kind in NOTEBOOK_CELL_LAYOUT
      ? NOTEBOOK_CELL_LAYOUT[kind as NotebookCellKind]
      : null,
  max: NOTEBOOK_MAX_CELLS,
}

/**
 * Ячейки — в документ на позицию `index` (по умолчанию в конец). Занятый
 * идентификатор получает суффикс: ячейка не должна затереть другую, а
 * одинаковый вход — дать одинаковый документ.
 */
export function insertCells(doc: Y.Doc, cells: NotebookCell[], index?: number): void {
  insertBlocks(doc, CELLS, cells, index)
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
  const cells = readBlocks(doc, CELLS, (raw) => {
    const parsed = NotebookCell.safeParse(raw)
    return parsed.success ? parsed.data : null
  })
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
