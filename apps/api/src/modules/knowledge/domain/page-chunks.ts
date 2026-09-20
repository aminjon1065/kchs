import type { PageBlock } from '@kchs/contracts'
import { readPrincipalsFor } from '~/kernel/access/acl-service.js'
import { meili, meiliValue } from '~/kernel/search/index-service.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { blockText, loadPage } from './page-core.js'
import { type SemanticChunk, semanticForget, semanticIndex } from './semantic-port.js'

/**
 * Чанки страниц базы знаний (13-search-knowledge-ai.md §1, ADR-0095):
 * отдельный индекс Meilisearch `page_chunk` — кусок страницы находится и
 * цитируется целиком, а не тонет в теле объекта. Права — фильтром
 * `aclPrincipals` чанка (их ведёт ядро, `readPrincipalsFor`); выдачу всё равно
 * проверяет `authorize()`, поэтому рассинхрон индекса лишнего не покажет.
 *
 * Тот же разрез уходит в порт семантики: словесный и смысловой поиск смотрят
 * на одни и те же куски текста.
 */

/** Кусок текста — не длиннее: цитата должна помещаться в карточку выдачи. */
const CHUNK_CHARS = 1200
/** Куски короче не заводятся отдельно — приклеиваются к предыдущему. */
const CHUNK_MIN_CHARS = 120
/** Чанков на страницу не больше: очень длинная страница индексируется началом. */
const MAX_CHUNKS = 120

export interface PageChunkDocument {
  /** `<pageId>_<blockId>_<n>` — устойчив, пока блок и порядок кусков не менялись. */
  id: string
  pageId: string
  blockId: string | null
  spaceId: string | null
  title: string
  heading: string | null
  text: string
  status: string
  ownerId: string | null
  aclPrincipals: string[]
  updatedAt: number
}

export function pageChunkIndexName(): string {
  return `${config().MEILI_INDEX_PREFIX}page_chunk`
}

const index = () => meili().index<PageChunkDocument>(pageChunkIndexName())

export async function ensurePageChunkIndex(): Promise<void> {
  try {
    await meili().createIndex(pageChunkIndexName(), { primaryKey: 'id' })
  } catch {
    // индекс уже существует
  }
  await index().updateSettings({
    searchableAttributes: ['title', 'heading', 'text'],
    filterableAttributes: ['pageId', 'spaceId', 'aclPrincipals', 'ownerId', 'status', 'updatedAt'],
    sortableAttributes: ['updatedAt'],
    pagination: { maxTotalHits: 2000 },
  })
}

/** Заголовок, под которым идёт кусок: подпись блока или первый его заголовок. */
function headingOf(block: PageBlock, text: string): string | null {
  const title = block.title?.trim()
  if (title) return title.slice(0, 300)
  const first = text.split('\n')[0]?.trim()
  return first && first.length <= 200 ? first : null
}

/**
 * Разбивка блока на куски по абзацам: абзац целиком, пока кусок не перерос
 * `CHUNK_CHARS`. Очень длинный абзац режется по границе символов.
 */
function splitBlock(text: string): string[] {
  const parts: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    if (current.length > 0 && current.length + line.length + 1 > CHUNK_CHARS) {
      parts.push(current)
      current = ''
    }
    if (line.length > CHUNK_CHARS) {
      if (current) {
        parts.push(current)
        current = ''
      }
      for (let at = 0; at < line.length; at += CHUNK_CHARS) {
        parts.push(line.slice(at, at + CHUNK_CHARS))
      }
      continue
    }
    current = current ? `${current}\n${line}` : line
  }
  if (current) parts.push(current)
  // Хвост короче минимума прилипает к предыдущему куску
  const merged: string[] = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (last && part.length < CHUNK_MIN_CHARS && last.length + part.length <= CHUNK_CHARS * 1.5) {
      merged[merged.length - 1] = `${last}\n${part}`
      continue
    }
    merged.push(part)
  }
  return merged
}

/** Куски страницы: по блокам, каждый — со своим заголовком и якорем на блок. */
export function pageChunks(pageId: string, blocks: readonly PageBlock[]): SemanticChunk[] {
  const chunks: SemanticChunk[] = []
  for (const block of blocks) {
    const text = blockText(block).trim()
    if (!text) continue
    const heading = headingOf(block, text)
    const parts = splitBlock(text)
    parts.forEach((part, n) => {
      if (chunks.length >= MAX_CHUNKS) return
      chunks.push({ id: `${pageId}_${block.id}_${n}`, blockId: block.id, heading, text: part })
    })
  }
  return chunks
}

/**
 * Переиндексация чанков страницы: старые документы страницы удаляются, новые
 * добавляются, тот же разрез уходит в порт семантики. Meilisearch недоступен —
 * это предупреждение, а не ошибка вызывающего (как у поиска объектов).
 */
export async function indexPageChunks(pageId: string): Promise<void> {
  const row = await loadPage(db(), pageId)
  if (!row) {
    await removePageChunks(pageId)
    return
  }
  const chunks = pageChunks(pageId, row.blocks)
  const aclPrincipals = await readPrincipalsFor(pageId)
  const updatedAt = Math.floor(new Date(row.updatedAt).getTime() / 1000)
  const documents: PageChunkDocument[] = chunks.map((chunk) => ({
    id: chunk.id,
    pageId,
    blockId: chunk.blockId,
    spaceId: row.spaceId,
    title: row.title,
    heading: chunk.heading,
    text: chunk.text,
    status: row.status,
    ownerId: row.registryOwnerId,
    aclPrincipals,
    updatedAt,
  }))
  try {
    await index().deleteDocuments({ filter: `pageId = ${meiliValue(pageId)}` })
    if (documents.length > 0) await index().addDocuments(documents)
  } catch (error) {
    logger().warn(
      { err: error, module: 'knowledge', pageId },
      'чанки страницы не переиндексированы',
    )
  }
  await semanticIndex(pageId, chunks)
}

export async function removePageChunks(pageId: string): Promise<void> {
  try {
    await index().deleteDocuments({ filter: `pageId = ${meiliValue(pageId)}` })
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge', pageId }, 'чанки страницы не удалены')
  }
  await semanticForget(pageId)
}

/** Поиск по чанкам; Meilisearch недоступен — пустая выдача, не ошибка. */
export async function searchPageChunks(
  filter: string,
  q: string,
  limit: number,
): Promise<PageChunkDocument[]> {
  try {
    const result = await index().search(q, {
      limit,
      filter,
      attributesToHighlight: ['text'],
      highlightPreTag: '<mark>',
      highlightPostTag: '</mark>',
      attributesToCrop: ['text'],
      cropLength: 40,
    })
    return result.hits.map((hit) => ({
      ...hit,
      text: (hit as { _formatted?: { text?: string } })._formatted?.text ?? hit.text,
    }))
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge' }, 'поиск по базе знаний недоступен')
    return []
  }
}
