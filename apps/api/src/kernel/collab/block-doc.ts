import type { RichBody } from '@kchs/contracts'
import * as Y from 'yjs'
import { fragmentToRichBody, richBodyToFragment } from './rich-text.js'

/**
 * Документ Yjs из блоков (ADR-0071): тетрадь, отчёт. Корневые типы — `Y.Map`
 * блоков по идентификатору и `Y.Array` их порядка; блок — `Y.Map` с ключами из
 * раскладки его вида: `rich` — `Y.XmlFragment` (текст Tiptap), `text` — `Y.Text`,
 * `json` — значение целиком. Модуль знает раскладку и схему блока, ядро — как
 * переводить документ в JSON и обратно.
 */

export type BlockValueKind = 'rich' | 'text' | 'json'
export type BlockLayout = Readonly<Record<string, BlockValueKind>>

export interface BlockDocDefinition {
  /** Имена корневых типов: карта блоков и массив порядка. */
  blocks: string
  order: string
  /** Раскладка значений блока по его виду; null — вид неизвестен. */
  layoutOf: (kind: unknown) => BlockLayout | null
  /** Блоков в документе не больше. */
  max: number
}

/** Блок с идентификатором и видом — остальное читает раскладка. */
export interface BlockValues {
  id: string
  kind: string
}

/** Блок → `Y.Map` по раскладке его вида. */
export function blockToYMap(block: BlockValues, layout: BlockLayout): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  const values = block as unknown as Record<string, unknown>
  for (const [key, kind] of Object.entries(layout)) {
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
 * Блоки — в документ на позицию `index` (по умолчанию в конец). Занятый
 * идентификатор получает суффикс: блок не затирает другой, а одинаковый вход
 * даёт одинаковый документ.
 */
export function insertBlocks(
  doc: Y.Doc,
  definition: BlockDocDefinition,
  blocks: readonly BlockValues[],
  index?: number,
): void {
  const map = doc.getMap<Y.Map<unknown>>(definition.blocks)
  const order = doc.getArray<string>(definition.order)
  const ids: string[] = []
  for (const block of blocks) {
    const layout = definition.layoutOf(block.kind)
    if (!layout) continue
    let id = block.id
    for (let n = 2; map.has(id) || ids.includes(id); n++) id = `${block.id.slice(0, 34)}-${n}`
    map.set(id, blockToYMap({ ...block, id }, layout))
    ids.push(id)
  }
  order.insert(Math.min(index ?? order.length, order.length), ids)
}

/**
 * Блоки по порядку (повтор идентификатора — один раз): значения по раскладке,
 * затем схема модуля. Блок, не прошедший схему, в снимок не попадает, но и из
 * документа не удаляется — документ пишут клиенты.
 */
export function readBlocks<T>(
  doc: Y.Doc,
  definition: BlockDocDefinition,
  parse: (raw: Record<string, unknown>) => T | null,
): T[] {
  const map = doc.getMap<unknown>(definition.blocks)
  const seen = new Set<string>()
  const out: T[] = []
  for (const id of doc.getArray<unknown>(definition.order).toArray()) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    const item = map.get(id)
    if (!(item instanceof Y.Map)) continue
    const layout = definition.layoutOf(item.get('kind'))
    if (!layout) continue
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
    // Идентификатор — ключ в карте блоков: поле блока могло разойтись с ним
    raw.id = id
    const block = parse(raw)
    if (block) out.push(block)
    if (out.length >= definition.max) break
  }
  return out
}
