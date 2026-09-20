import { eq } from 'drizzle-orm'
import type { Subscriber } from '~/kernel/events/types.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { indexObject } from '~/kernel/search/index-service.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { meetings } from '~/shared/db/schema/index.js'
import { ProtocolService } from './protocol-service.js'

/**
 * Подписчики протокола (11-communications-meetings.md §4, ADR-0093):
 * завершившаяся встреча открывает организатору дело «Проверить протокол»
 * (протокол заводится, если его ещё нет); правки протокола обновляют поиск.
 */
export const protocolSubscribers: Subscriber[] = [
  {
    name: 'meetings-protocol-review',
    types: ['meeting.ended'],
    handle: async (event) => {
      const meetingId = event.object?.id
      // Встреча, отменённая до начала, протокола не требует
      if (!meetingId || event.payload.reason === 'cancelled') return
      const ctx = systemCtx('meetings.protocol')
      const [meeting] = await db()
        .select({ organizerId: meetings.organizerId })
        .from(meetings)
        .where(eq(meetings.id, meetingId))
        .limit(1)
      if (!meeting?.organizerId) return
      const organizerId = meeting.organizerId
      await db().transaction(async (tx) => {
        const protocolId = await ProtocolService.ensure(tx, ctx, meetingId)
        await InboxService.open(tx, ctx, {
          userId: organizerId,
          kind: 'review_protocol',
          objectId: protocolId,
          titleKey: 'inbox.tpl.reviewProtocol',
          params: { title: event.object?.title ?? '' },
        })
      })
    },
  },
  {
    name: 'meetings-protocol-search',
    types: ['protocol.updated', 'protocol.confirmed'],
    handle: async (event) => {
      if (event.object) await indexObject(event.object.id)
    },
  },
]
