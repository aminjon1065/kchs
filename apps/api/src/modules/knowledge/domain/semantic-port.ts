import { logger } from '~/shared/logger/index.js'

/**
 * Поиск по смыслу в базе знаний (13-search-knowledge-ai.md §1 «Семантика»,
 * ADR-0095). Чанки страниц ведёт сама база знаний (`page-chunks.ts`,
 * Meilisearch `page_chunk`); эмбеддинги и векторный индекс — отдельная часть
 * системы, которая подключается сюда источником. Порт мягко деградирует:
 * источник не подключён, не готов или не ответил — выдача остаётся словесной
 * (Meilisearch), и ни один вызывающий об этом не спотыкается.
 *
 * Права: источник получает принципалов смотрящего лишь как подсказку для
 * предварительного отбора — выдачу всё равно проверяет `authorize()` в
 * `page-search.ts`, поэтому ошибка источника не может показать лишнего.
 */

/** Кусок страницы для векторного индекса: тот же разрез, что у `page_chunk`. */
export interface SemanticChunk {
  /** Идентификатор чанка — `<pageId>_<blockId>_<n>`, устойчив между правками. */
  id: string
  blockId: string | null
  /** Заголовок, под которым лежит кусок (для сниппета и цитаты). */
  heading: string | null
  text: string
}

export interface SemanticQuery {
  text: string
  /** Пространство; null — по всем, что видит смотрящий. */
  spaceId: string | null
  /** Принципалы смотрящего — подсказка для отбора на стороне источника. */
  principals: readonly string[]
  limit: number
}

export interface SemanticHit {
  pageId: string
  blockId: string | null
  /** Близость 0…1: чем больше, тем ближе по смыслу. */
  score: number
  /** Фрагмент чанка; null — сниппет соберёт сама база знаний. */
  text: string | null
}

export interface SemanticSource {
  /** Готов ли источник отвечать: модель загружена, индекс построен. */
  ready?: () => Promise<boolean>
  search: (query: SemanticQuery) => Promise<SemanticHit[]>
  /** Чанки страницы пересобраны — источник пересчитывает эмбеддинги. */
  index?: (pageId: string, chunks: readonly SemanticChunk[]) => Promise<void>
  /** Страница удалена или скрыта — её векторы больше не нужны. */
  forget?: (pageId: string) => Promise<void>
}

let source: SemanticSource | null = null

/** Источник семантики подключает своя часть системы при старте, если она есть. */
export function setSemanticSource(next: SemanticSource | null): void {
  source = next
}

/** Готов ли источник отвечать сейчас; всё, что не «да», — это «нет». */
export async function semanticReady(): Promise<boolean> {
  if (!source) return false
  if (!source.ready) return true
  try {
    return await source.ready()
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge' }, 'источник семантики не ответил о готовности')
    return false
  }
}

/**
 * Похожие по смыслу куски страниц; null — источника нет или он не ответил
 * (вызывающий показывает словесную выдачу и не считает это ошибкой).
 */
export async function semanticSearch(query: SemanticQuery): Promise<SemanticHit[] | null> {
  if (!source) return null
  try {
    const hits = await source.search(query)
    return hits.slice(0, query.limit)
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge' }, 'поиск по смыслу не выполнен')
    return null
  }
}

/** Пересчёт векторов страницы; без источника — ничего не делает. */
export async function semanticIndex(
  pageId: string,
  chunks: readonly SemanticChunk[],
): Promise<void> {
  if (!source?.index) return
  try {
    await source.index(pageId, chunks)
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge', pageId }, 'векторы страницы не обновлены')
  }
}

/** Забыть векторы страницы; без источника — ничего не делает. */
export async function semanticForget(pageId: string): Promise<void> {
  if (!source?.forget) return
  try {
    await source.forget(pageId)
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge', pageId }, 'векторы страницы не удалены')
  }
}
