import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, pages } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'

/** Дело Входящих владельца страницы, когда подошёл срок пересмотра. */
export const REVIEW_INBOX_KIND = 'review_page'

/** Страниц за один проход — не больше: остальные дождутся следующего. */
const BATCH = 200

/**
 * Пересмотр страниц (13-search-knowledge-ai.md §2, ADR-0095): задание обходит
 * страницы, у которых подошёл срок пересмотра, переводит их в `review` и
 * открывает владельцу дело «Пересмотреть страницу». Повторно на тот же срок
 * дело не открывается (`review_opened_for`), поэтому проход идемпотентен.
 */
export async function reviewDuePages(today = new Date()): Promise<number> {
  const day = today.toISOString().slice(0, 10)
  const due = await db()
    .select({
      id: pages.id,
      status: pages.status,
      reviewAt: pages.reviewAt,
      ownerId: pages.ownerId,
      title: objects.title,
      spaceId: objects.spaceId,
    })
    .from(pages)
    .innerJoin(objects, eq(objects.id, pages.id))
    .where(
      and(
        isNull(objects.deletedAt),
        isNull(objects.archivedAt),
        sql`${pages.reviewAt} IS NOT NULL`,
        lte(pages.reviewAt, day),
        or(isNull(pages.reviewOpenedFor), ne(pages.reviewOpenedFor, pages.reviewAt)),
      ),
    )
    .limit(BATCH)
  if (due.length === 0) return 0

  const ctx = systemCtx('knowledge.review')
  let opened = 0
  for (const page of due) {
    const reviewAt = page.reviewAt as string
    try {
      await db().transaction(async (tx) => {
        await tx
          .update(pages)
          .set({ status: 'review', reviewOpenedFor: reviewAt, updatedAt: sql`now()` })
          .where(eq(pages.id, page.id))
        if (page.status !== 'review') {
          await ObjectService.update(
            tx,
            ctx,
            page.id,
            { meta: { status: 'review' }, mergeMeta: true },
            { silent: true },
          )
          await publishEvent(tx, ctx, {
            type: 'page.status_changed',
            object: { id: page.id, type: 'page', spaceId: page.spaceId, title: page.title },
            payload: { from: page.status, to: 'review', cause: 'review_due' },
          })
        }
        await publishEvent(tx, ctx, {
          type: 'page.review_due',
          object: { id: page.id, type: 'page', spaceId: page.spaceId, title: page.title },
          payload: { reviewAt, ownerId: page.ownerId },
        })
        if (page.ownerId) {
          await InboxService.open(tx, ctx, {
            userId: page.ownerId,
            kind: REVIEW_INBOX_KIND,
            objectId: page.id,
            titleKey: 'inbox.tpl.reviewPage',
            params: { title: page.title },
            dueAt: `${reviewAt}T23:59:59.000Z`,
            dedupeKey: `review-page:${page.id}:${reviewAt}`,
          })
        }
      })
      opened += 1
    } catch (error) {
      logger().warn(
        { err: error, module: 'knowledge', pageId: page.id },
        'страница не отправлена на пересмотр',
      )
    }
  }
  return opened
}
