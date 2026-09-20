import { PAGE_BLOCK_LAYOUT, PageBlock, type PageBlockKind } from '@kchs/contracts'
import * as Y from 'yjs'
import { type CellMap, newCellId } from '~/features/notebooks/notebook-doc.js'

/**
 * Документ Yjs страницы на клиенте (ADR-0095): корневые типы и ключи — как у
 * тетради (`blocks`/`order`), поэтому порядок, перенос, дублирование и удаление
 * блоков — функции `notebook-doc`; здесь — создание блока по раскладке страницы
 * и доступ к его значениям.
 */

/** Новый блок вида: значения по умолчанию — из контракта. */
export function createPageBlock(
  kind: PageBlockKind,
  init: Record<string, unknown> = {},
): { id: string; map: CellMap } {
  const id = newCellId()
  const values = PageBlock.parse({ ...init, id, kind }) as unknown as Record<string, unknown>
  const map = new Y.Map<unknown>()
  for (const [key, valueKind] of Object.entries(PAGE_BLOCK_LAYOUT[kind])) {
    const value = values[key]
    if (valueKind === 'rich') map.set(key, new Y.XmlFragment())
    else if (valueKind === 'text') map.set(key, new Y.Text(typeof value === 'string' ? value : ''))
    else if (value !== undefined) map.set(key, value)
  }
  return { id, map }
}

/** Тело текстового блока — фрагмент Tiptap; без него редактор не рисуется. */
export function bodyFragment(block: CellMap): Y.XmlFragment | null {
  const value = block.get('body')
  return value instanceof Y.XmlFragment ? value : null
}

/** Подпись под изображением — `Y.Text`: правки двух авторов сливаются посимвольно. */
export function captionText(block: CellMap): Y.Text | null {
  const value = block.get('caption')
  return value instanceof Y.Text ? value : null
}

/** Идентификатор объекта для вида блока: у каждого вида своё поле. */
export function embedKeyOf(kind: PageBlockKind): string | null {
  if (kind === 'chart') return 'chartId'
  if (kind === 'metric') return 'metricId'
  if (kind === 'dataset') return 'datasetId'
  if (kind === 'tasks') return 'projectId'
  if (kind === 'map') return 'mapId'
  if (kind === 'image' || kind === 'file') return 'fileId'
  return null
}
