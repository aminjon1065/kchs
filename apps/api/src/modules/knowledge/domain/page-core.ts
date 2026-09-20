import {
  type PageBlock,
  type PageOutlineItem,
  type PageStatus,
  richBodyText,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import type { Executor } from '~/shared/db/client.js'
import { objects, pages } from '~/shared/db/schema/index.js'

/**
 * Чтение страницы из базы (ADR-0095) — общее для карточки, версий, печати и
 * индексации: снимок блоков и состояние. Права проверяют вызывающие службы
 * через `authorize()`.
 */

export interface PageRow {
  id: string
  status: PageStatus
  template: string
  blocks: PageBlock[]
  /** Владелец страницы: отвечает за пересмотр (может отличаться от владельца объекта). */
  ownerId: string | null
  reviewAt: string | null
  reviewOpenedFor: string | null
  publishedAt: string | null
  publishedBy: string | null
  versionNumber: number
  acknowledgmentAt: string | null
  title: string
  spaceId: string | null
  parentId: string | null
  /** Владелец объекта в реестре — им определяются права, а не ответственность. */
  registryOwnerId: string | null
  version: number
  updatedAt: string
}

const select = (executor: Executor) =>
  executor
    .select({
      id: pages.id,
      status: pages.status,
      template: pages.template,
      blocks: pages.blocks,
      ownerId: pages.ownerId,
      reviewAt: pages.reviewAt,
      reviewOpenedFor: pages.reviewOpenedFor,
      publishedAt: pages.publishedAt,
      publishedBy: pages.publishedBy,
      versionNumber: pages.versionNumber,
      acknowledgmentAt: pages.acknowledgmentAt,
      title: objects.title,
      spaceId: objects.spaceId,
      parentId: objects.parentId,
      registryOwnerId: objects.ownerId,
      version: objects.version,
      updatedAt: objects.updatedAt,
    })
    .from(pages)
    .innerJoin(objects, eq(objects.id, pages.id))

export async function loadPage(executor: Executor, id: string): Promise<PageRow | null> {
  const [row] = await select(executor).where(eq(pages.id, id)).limit(1)
  return (row as PageRow | undefined) ?? null
}

/** Заголовки блока: подпись блока и заголовки его текста (Tiptap `heading`). */
interface Heading {
  index: number
  level: number
  text: string
}

interface JsonNode {
  type?: unknown
  attrs?: unknown
  content?: unknown
}

function headingText(node: JsonNode): string {
  const content = Array.isArray(node.content) ? node.content : []
  return content
    .map((child) => {
      const value = (child as { text?: unknown }).text
      return typeof value === 'string' ? value : ''
    })
    .join('')
    .trim()
}

function headingsOf(block: PageBlock): Heading[] {
  if (block.kind !== 'text') return []
  const content = Array.isArray(block.body.content) ? block.body.content : []
  const out: Heading[] = []
  let index = 0
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw as JsonNode
    if (node.type !== 'heading') continue
    index += 1
    const text = headingText(node)
    if (!text) continue
    const level = (node.attrs as { level?: unknown } | undefined)?.level
    out.push({
      index,
      level: typeof level === 'number' && level >= 1 && level <= 4 ? level : 2,
      text: text.slice(0, 300),
    })
  }
  return out
}

/**
 * Оглавление страницы (03-screens.md §18): подпись блока — пункт первого
 * уровня, заголовки текста — вложенные пункты; якорь пункта — идентификатор
 * блока и порядковый номер заголовка внутри него.
 */
export function pageOutline(blocks: readonly PageBlock[]): PageOutlineItem[] {
  const items: PageOutlineItem[] = []
  for (const block of blocks) {
    const title = block.title?.trim()
    if (title) items.push({ blockId: block.id, index: 0, level: 1, text: title.slice(0, 300) })
    for (const heading of headingsOf(block)) {
      items.push({
        blockId: block.id,
        index: heading.index,
        level: title ? Math.min(heading.level + 1, 4) : heading.level,
        text: heading.text,
      })
    }
  }
  return items
}

/** Текст блока для поиска, версий и печати; у встроенных объектов текста нет. */
export function blockText(block: PageBlock): string {
  const parts: string[] = []
  if (block.title) parts.push(block.title)
  if (block.kind === 'text') parts.push(richBodyText(block.body))
  if (block.kind === 'table') {
    if (block.columns.length > 0) parts.push(block.columns.join('\t'))
    for (const row of block.rows) parts.push(row.join('\t'))
  }
  if (block.kind === 'image' && block.caption) parts.push(block.caption)
  return parts.filter(Boolean).join('\n')
}

/** Текст всей страницы: подписи и содержимое блоков по порядку. */
export function pageText(blocks: readonly PageBlock[]): string {
  return blocks.map(blockText).filter(Boolean).join('\n\n')
}

/** Объекты реестра, на которые ссылаются блоки, — зависимости страницы. */
export function pageDependencies(blocks: readonly PageBlock[]): string[] {
  const ids = new Set<string>()
  for (const block of blocks) {
    if (block.kind === 'chart' && block.chartId) ids.add(block.chartId)
    if (block.kind === 'metric' && block.metricId) ids.add(block.metricId)
    if (block.kind === 'dataset' && block.datasetId) ids.add(block.datasetId)
    if (block.kind === 'map') {
      if (block.mapId) ids.add(block.mapId)
      if (block.layerId) ids.add(block.layerId)
    }
    if (block.kind === 'tasks' && block.projectId) ids.add(block.projectId)
    if ((block.kind === 'image' || block.kind === 'file') && block.fileId) ids.add(block.fileId)
  }
  return [...ids]
}
