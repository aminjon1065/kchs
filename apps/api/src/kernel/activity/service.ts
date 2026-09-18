import type { Activity, EventEnvelope } from '@kchs/contracts'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { activities } from '~/shared/db/schema/index.js'
import { directory } from '../directory/port.js'
import type { Subscriber } from '../events/types.js'

/**
 * Лента активности строится из событий (02-platform-kernel.md §5).
 * Одно событие → максимум одна человекочитаемая запись.
 */
const VERB_BY_TYPE: Record<string, { verb: string; key: string }> = {
  'object.created': { verb: 'created', key: 'activity.object.created' },
  'object.updated': { verb: 'updated', key: 'activity.object.updated' },
  'object.moved': { verb: 'moved', key: 'activity.object.moved' },
  'object.archived': { verb: 'archived', key: 'activity.object.archived' },
  'object.restored': { verb: 'restored', key: 'activity.object.restored' },
  'object.trashed': { verb: 'trashed', key: 'activity.object.trashed' },
  'object.shared': { verb: 'shared', key: 'activity.object.shared' },
  'object.linked': { verb: 'linked', key: 'activity.object.linked' },
  'message.posted': { verb: 'commented', key: 'activity.message.posted' },
  'file.version_added': { verb: 'version_added', key: 'activity.file.version_added' },
  'file.uploaded': { verb: 'uploaded', key: 'activity.file.uploaded' },
  'space.member_added': { verb: 'member_added', key: 'activity.space.member_added' },
}

export async function recordActivity(event: EventEnvelope): Promise<void> {
  const mapping = VERB_BY_TYPE[event.type]
  if (!mapping || !event.object) return

  // Имя автора денормализуется в запись: лента читается чаще, чем пишется
  const actorName = event.actor.userId
    ? await directory().displayName(event.actor.userId)
    : 'Система'

  await db()
    .insert(activities)
    .values({
      eventId: event.id,
      objectId: event.object.id,
      spaceId: event.object.spaceId,
      actorId: event.actor.userId,
      onBehalfOf: event.actor.onBehalfOf,
      verb: mapping.verb,
      summary: {
        key: mapping.key,
        params: {
          actor: actorName,
          title: event.object.title ?? '',
          ...(event.changedFields ? { fields: event.changedFields.join(', ') } : {}),
          ...event.payload,
        },
      },
      occurredAt: event.occurredAt,
    })
}

export const activitySubscriber: Subscriber = {
  name: 'kernel-activity',
  types: ['object.*', 'message.posted', 'file.*', 'space.member_added'],
  handle: recordActivity,
}

export async function listActivity(
  objectId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ items: Activity[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? 30, 100)
  const rows = await db()
    .select()
    .from(activities)
    .where(
      options.cursor
        ? sql`${activities.objectId} = ${objectId} AND ${activities.id} < ${Number(options.cursor)}`
        : eq(activities.objectId, objectId),
    )
    .orderBy(desc(activities.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return {
    items: page.map(toActivity),
    nextCursor: hasMore ? String(page[page.length - 1]?.id) : null,
  }
}

function toActivity(row: typeof activities.$inferSelect): Activity {
  return {
    id: String(row.id),
    objectId: row.objectId,
    spaceId: row.spaceId,
    actorId: row.actorId,
    onBehalfOf: row.onBehalfOf,
    verb: row.verb,
    summary: row.summary,
    occurredAt: row.occurredAt,
  }
}
