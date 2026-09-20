import type { PageChunkHit, PageSearchQuery, PageSearchResult } from '@kchs/contracts'
import { authorize, visibilityPrincipals } from '~/kernel/access/authorize.js'
import { meiliValue } from '~/kernel/search/index-service.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { type PageChunkDocument, pageChunks, searchPageChunks } from './page-chunks.js'
import { loadPage } from './page-core.js'
import { semanticReady, semanticSearch } from './semantic-port.js'

/**
 * Поиск по базе знаний (13-search-knowledge-ai.md §1–2, ADR-0095): слова —
 * индекс `page_chunk`, смысл — порт семантики. Источника семантики нет или он
 * молчит — выдача остаётся словесной, и это не ошибка.
 *
 * Права: фильтр по принципалам в индексе, затем `authorize(view)` на каждую
 * найденную страницу — выдача не раскрывает даже названия недоступных страниц.
 */

/** Смысловых совпадений в выдаче — не больше трети: слова остаются основой. */
const SEMANTIC_SHARE = 1 / 3

function chunkFilter(ctx: UserCtx, query: PageSearchQuery): string {
  const parts: string[] = []
  if (query.spaceId) parts.push(`spaceId = ${meiliValue(query.spaceId)}`)
  const principals = visibilityPrincipals(ctx)
  if (principals) {
    const keys = principals.map((key) => `aclPrincipals = ${meiliValue(key)}`)
    keys.push(`ownerId = ${meiliValue(ctx.userId)}`)
    parts.push(`(${keys.join(' OR ')})`)
  }
  return parts.join(' AND ')
}

/** Сниппет смыслового совпадения: текст чанка из источника или из снимка страницы. */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function toTextHit(document: PageChunkDocument): PageChunkHit {
  return {
    pageId: document.pageId,
    blockId: document.blockId,
    title: document.title,
    spaceId: document.spaceId,
    heading: document.heading,
    snippet: document.text,
    source: 'text',
    score: null,
  }
}

export const PageSearch = {
  async run(ctx: UserCtx, query: PageSearchQuery): Promise<PageSearchResult> {
    const filter = chunkFilter(ctx, query)
    const textHits = await searchPageChunks(filter, query.q, query.limit)
    const items: PageChunkHit[] = textHits.map(toTextHit)

    let semantic = false
    if (query.semantic && (await semanticReady())) {
      const room = Math.max(0, Math.ceil(query.limit * SEMANTIC_SHARE))
      const hits = await semanticSearch({
        text: query.q,
        spaceId: query.spaceId ?? null,
        principals: visibilityPrincipals(ctx) ?? [],
        limit: room,
      })
      if (hits) {
        semantic = true
        const seen = new Set(items.map((item) => `${item.pageId}:${item.blockId ?? ''}`))
        for (const hit of hits) {
          const key = `${hit.pageId}:${hit.blockId ?? ''}`
          if (seen.has(key)) continue
          seen.add(key)
          const snippet = await snippetOf(hit.pageId, hit.blockId, hit.text)
          if (!snippet) continue
          items.push({
            pageId: hit.pageId,
            blockId: hit.blockId,
            title: snippet.title,
            spaceId: snippet.spaceId,
            heading: snippet.heading,
            snippet: snippet.text,
            source: 'semantic',
            score: hit.score,
          })
        }
      }
    }

    // Пост-проверка прав: рассинхрон индекса не должен показывать чужое
    const allowed: PageChunkHit[] = []
    const checked = new Map<string, boolean>()
    for (const item of items) {
      let ok = checked.get(item.pageId)
      if (ok === undefined) {
        ok = (await authorize(ctx, 'view', item.pageId, { soft: true })).allowed
        checked.set(item.pageId, ok)
      }
      if (ok) allowed.push(item)
      if (allowed.length >= query.limit) break
    }
    return { items: allowed, semantic }
  },
}

/** Заголовок и текст куска из снимка страницы — когда источник их не дал. */
async function snippetOf(
  pageId: string,
  blockId: string | null,
  text: string | null,
): Promise<{ title: string; spaceId: string | null; heading: string | null; text: string } | null> {
  const row = await loadPage(db(), pageId)
  if (!row) return null
  const chunks = pageChunks(pageId, row.blocks)
  const chunk = blockId ? chunks.find((item) => item.blockId === blockId) : chunks[0]
  const body = text ?? chunk?.text ?? ''
  if (!body.trim()) return null
  return {
    title: row.title,
    spaceId: row.spaceId,
    heading: chunk?.heading ?? null,
    text: escapeHtml(body.slice(0, 400)),
  }
}
