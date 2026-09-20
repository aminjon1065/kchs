import {
  PROTOCOL_BLOCK_LAYOUT,
  PROTOCOL_DOC,
  PROTOCOL_SUMMARY_KEY,
  ProtocolBlock,
  type ProtocolBlockKind,
} from '@kchs/contracts'
import * as Y from 'yjs'
import { type CellMap, newCellId } from '~/features/notebooks/notebook-doc.js'

/**
 * Документ Yjs протокола на клиенте (ADR-0093): корневые типы и ключи — как у
 * тетради, поэтому порядок, перенос и удаление блоков — функции `notebook-doc`;
 * здесь — создание блока по раскладке протокола и резюме встречи.
 */

export const metaOf = (doc: Y.Doc) => doc.getMap<unknown>(PROTOCOL_DOC.meta)

/** Новый блок вида: значения по умолчанию — из контракта. */
export function createProtocolBlock(
  kind: ProtocolBlockKind,
  init: Record<string, unknown> = {},
): { id: string; map: CellMap } {
  const id = newCellId()
  const values = ProtocolBlock.parse({ ...init, id, kind }) as unknown as Record<string, unknown>
  const map = new Y.Map<unknown>()
  for (const [key, valueKind] of Object.entries(PROTOCOL_BLOCK_LAYOUT[kind])) {
    const value = values[key]
    if (valueKind === 'rich') map.set(key, new Y.XmlFragment())
    else if (valueKind === 'text') map.set(key, new Y.Text(typeof value === 'string' ? value : ''))
    else if (value !== undefined) map.set(key, value)
  }
  return { id, map }
}

/** Резюме встречи из документа: его пишет черновик ИИ, дальше правит человек. */
export function readSummary(doc: Y.Doc): string {
  const value = metaOf(doc).get(PROTOCOL_SUMMARY_KEY)
  return typeof value === 'string' ? value : ''
}

/** Заголовок блока — `Y.Text`: правки двух авторов сливаются посимвольно. */
export function titleText(block: CellMap): Y.Text | null {
  const value = block.get('title')
  return value instanceof Y.Text ? value : null
}

/** Тело блока — фрагмент Tiptap; без него редактор не рисуется. */
export function bodyFragment(block: CellMap): Y.XmlFragment | null {
  const value = block.get('body')
  return value instanceof Y.XmlFragment ? value : null
}
