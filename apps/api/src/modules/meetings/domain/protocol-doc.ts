import {
  PROTOCOL_BLOCK_LAYOUT,
  PROTOCOL_DOC,
  PROTOCOL_MAX_BLOCKS,
  PROTOCOL_SUMMARY_KEY,
  ProtocolBlock,
  type ProtocolBlockKind,
} from '@kchs/contracts'
import * as Y from 'yjs'
import { type BlockDocDefinition, insertBlocks, readBlocks } from '~/kernel/collab/block-doc.js'

/**
 * Документ Yjs протокола ↔ JSON (ADR-0093), как у тетради (ADR-0071):
 * раскладка — в контракте `PROTOCOL_BLOCK_LAYOUT`, её же использует клиент.
 * Снимок читается из документа, который пишут клиенты: блок, не прошедший
 * контракт, в снимок не попадает, но и из документа не удаляется.
 */

/**
 * Клиент Yjs начального состояния: у всех процессов один и тот же, поэтому
 * одинаковый JSON даёт одинаковые операции и при слиянии не удваивается.
 */
const INITIAL_CLIENT_ID = 1

export interface ProtocolBody {
  blocks: ProtocolBlock[]
  summary: string | null
}

export const PROTOCOL_BLOCKS: BlockDocDefinition = {
  blocks: PROTOCOL_DOC.blocks,
  order: PROTOCOL_DOC.order,
  layoutOf: (kind) =>
    typeof kind === 'string' && kind in PROTOCOL_BLOCK_LAYOUT
      ? PROTOCOL_BLOCK_LAYOUT[kind as ProtocolBlockKind]
      : null,
  max: PROTOCOL_MAX_BLOCKS,
}

/**
 * Блоки — в документ на позицию `index` (по умолчанию в конец). Занятый
 * идентификатор получает суффикс: блок не должен затереть другой, а одинаковый
 * вход — дать одинаковый документ.
 */
export function insertProtocolBlocks(
  doc: Y.Doc,
  blocks: readonly ProtocolBlock[],
  index?: number,
): void {
  insertBlocks(doc, PROTOCOL_BLOCKS, blocks, index)
}

/** Резюме встречи: его пишет черновик ИИ, дальше правит человек. */
export function writeSummary(doc: Y.Doc, summary: string): void {
  doc.getMap<unknown>(PROTOCOL_DOC.meta).set(PROTOCOL_SUMMARY_KEY, summary)
}

/** Начальное состояние документа из JSON — детерминированное (см. INITIAL_CLIENT_ID). */
export function protocolState(body: ProtocolBody): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = INITIAL_CLIENT_ID
  doc.transact(() => {
    insertProtocolBlocks(doc, body.blocks)
    if (body.summary) writeSummary(doc, body.summary)
  })
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

/** Снимок документа: блоки по порядку (повтор идентификатора — один раз) и резюме. */
export function readProtocol(doc: Y.Doc): ProtocolBody {
  const blocks = readBlocks(doc, PROTOCOL_BLOCKS, (raw) => {
    const parsed = ProtocolBlock.safeParse(raw)
    return parsed.success ? parsed.data : null
  })
  const summary = doc.getMap<unknown>(PROTOCOL_DOC.meta).get(PROTOCOL_SUMMARY_KEY)
  return { blocks, summary: typeof summary === 'string' ? summary.slice(0, 8000) : null }
}

/**
 * Поручение блока создано: `taskId` пишет сервер в документ и снимок, чтобы
 * состояние поручения было видно прямо в протоколе у всех, кто его открыл.
 */
export function setBlockTask(doc: Y.Doc, blockId: string, taskId: string): void {
  const block = doc.getMap<unknown>(PROTOCOL_DOC.blocks).get(blockId)
  if (block instanceof Y.Map) block.set('taskId', taskId)
}
