import { and, eq, isNull } from 'drizzle-orm'
import type { Subscriber } from '~/kernel/events/types.js'
import { indexObject } from '~/kernel/search/index-service.js'
import { db } from '~/shared/db/client.js'
import { objectAncestors, objects } from '~/shared/db/schema/index.js'
import { indexPageChunks, removePageChunks } from './page-chunks.js'

/**
 * Подписчики базы знаний (ADR-0095): снимок страницы и смена состояния
 * обновляют объектный индекс и чанки `page_chunk`; смена прав — чанки страницы
 * и всех её страниц-потомков (объектный индекс поддерживает ядро); удаление
 * страницы чанки убирает.
 */

/** События текста и состояния: чанки одной страницы. */
const PAGE_EVENTS = ['page.updated', 'page.published', 'page.status_changed', 'page.restored']

/** События прав и переноса: чанки поддерева (принципалы наследуются). */
const SUBTREE_EVENTS = ['acl.changed', 'object.shared', 'object.moved', 'object.restored']

const GONE_EVENTS = ['object.trashed', 'object.deleted']

/** Страниц поддерева за одно событие — не больше: полный обход делает переиндексация. */
const SUBTREE_LIMIT = 500

/** Страницы поддерева объекта, включая его сам, если он страница. */
async function pagesUnder(objectId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: objects.id })
    .from(objects)
    .innerJoin(objectAncestors, eq(objectAncestors.objectId, objects.id))
    .where(
      and(
        eq(objectAncestors.ancestorId, objectId),
        eq(objects.type, 'page'),
        isNull(objects.deletedAt),
      ),
    )
    .limit(SUBTREE_LIMIT)
  return rows.map((row) => row.id)
}

export const pageSubscribers: Subscriber[] = [
  {
    name: 'knowledge-page-search',
    types: PAGE_EVENTS,
    handle: async (event) => {
      if (event.object) await indexObject(event.object.id)
    },
  },
  {
    name: 'knowledge-page-chunks',
    types: [...PAGE_EVENTS, ...SUBTREE_EVENTS, ...GONE_EVENTS],
    handle: async (event) => {
      const object = event.object
      if (!object) return
      const isPage = object.type === 'page'
      if (GONE_EVENTS.includes(event.type)) {
        if (isPage) await removePageChunks(object.id)
        else for (const id of await pagesUnder(object.id)) await removePageChunks(id)
        return
      }
      if (PAGE_EVENTS.includes(event.type)) {
        if (isPage) await indexPageChunks(object.id)
        return
      }
      // Права и перенос: страница и её потомки — у них те же принципалы
      if (isPage) await indexPageChunks(object.id)
      for (const id of await pagesUnder(object.id)) await indexPageChunks(id)
    },
  },
]
