import {
  PAGE_BLOCK_LAYOUT,
  PAGE_DOC,
  PAGE_MAX_BLOCKS,
  PageBlock,
  type PageBlockKind,
} from '@kchs/contracts'
import * as Y from 'yjs'
import { type BlockDocDefinition, insertBlocks, readBlocks } from '~/kernel/collab/block-doc.js'

/**
 * Документ Yjs страницы ↔ JSON (ADR-0095), как у тетради (ADR-0071) и
 * протокола (ADR-0093): раскладка — в контракте `PAGE_BLOCK_LAYOUT`, её же
 * использует клиент. Снимок читается из документа, который пишут клиенты: блок,
 * не прошедший контракт, в снимок не попадает, но и из документа не удаляется.
 */

/**
 * Клиент Yjs начального состояния: у всех процессов один и тот же, поэтому
 * одинаковый JSON даёт одинаковые операции и при слиянии не удваивается.
 */
const INITIAL_CLIENT_ID = 1

export const PAGE_BLOCKS: BlockDocDefinition = {
  blocks: PAGE_DOC.blocks,
  order: PAGE_DOC.order,
  layoutOf: (kind) =>
    typeof kind === 'string' && kind in PAGE_BLOCK_LAYOUT
      ? PAGE_BLOCK_LAYOUT[kind as PageBlockKind]
      : null,
  max: PAGE_MAX_BLOCKS,
}

/**
 * Блоки — в документ на позицию `index` (по умолчанию в конец). Занятый
 * идентификатор получает суффикс: блок не должен затереть другой, а одинаковый
 * вход — дать одинаковый документ.
 */
export function insertPageBlocks(doc: Y.Doc, blocks: readonly PageBlock[], index?: number): void {
  insertBlocks(doc, PAGE_BLOCKS, blocks, index)
}

/** Начальное состояние документа из JSON — детерминированное (см. INITIAL_CLIENT_ID). */
export function pageState(blocks: readonly PageBlock[]): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = INITIAL_CLIENT_ID
  doc.transact(() => insertPageBlocks(doc, blocks))
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

/** Снимок документа: блоки по порядку (повтор идентификатора — один раз). */
export function readPage(doc: Y.Doc): PageBlock[] {
  return readBlocks(doc, PAGE_BLOCKS, (raw) => {
    const parsed = PageBlock.safeParse(raw)
    return parsed.success ? parsed.data : null
  })
}

/** Документ из JSON и снимок, прочитанный из него же (без повторов блоков). */
export function buildPageDoc(blocks: readonly PageBlock[]): {
  state: Uint8Array
  blocks: PageBlock[]
} {
  const state = pageState(blocks)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const normalized = readPage(doc)
  doc.destroy()
  return { state, blocks: normalized }
}
