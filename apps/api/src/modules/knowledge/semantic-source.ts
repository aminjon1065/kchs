import {
  dropEmbeddings,
  indexChunks,
  semanticEnabled,
  semanticSearch,
} from '~/kernel/search/semantic.js'
import { systemCtx } from '~/shared/context.js'
import { KnowledgeSemantics } from './public.js'

/**
 * Семантика базы знаний (ADR-0095 × ADR-0099): порт модуля знаний получает
 * источник ядра — векторы кусков страниц в pgvector. Без настроенной модели
 * источник отвечает «не готов», и база знаний ищет словами.
 *
 * Права: источник отбирает кандидатов без пользователя (системный контекст) —
 * выдачу проверяет `authorize()` в поиске страниц, как договорено портом.
 */
export function connectKnowledgeSemantics(): void {
  KnowledgeSemantics.setSource({
    ready: async () => semanticEnabled(),
    search: async (query) => {
      const hits = await semanticSearch(systemCtx('knowledge.semantic'), query.text, query.limit, {
        types: ['page'],
      })
      return hits.map((hit) => ({
        pageId: hit.objectId,
        blockId: null,
        score: hit.score,
        text: hit.text,
      }))
    },
    index: async (pageId, chunks) => {
      await indexChunks(
        pageId,
        chunks.map((chunk) => ({
          text: chunk.heading ? `${chunk.heading}\n${chunk.text}` : chunk.text,
        })),
      )
    },
    forget: async (pageId) => dropEmbeddings(pageId),
  })
}
