import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { MeetingService } from '../domain/meeting-service.js'
import { decideKnock, pendingKnocks } from '../domain/waiting-room.js'

/**
 * Комната ожидания и входящий звонок (ADR-0091): решение по заявке принимает
 * тот, кто ведёт встречу (`manage`), отклонить звонок может приглашённый.
 */
export function registerMeetingsRoomRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /meetings/:id/knocks',
    auth: { action: 'manage' },
    tags: ['meetings'],
    summary: 'Кто ждёт в комнате ожидания',
    handler: async (request) => ({ items: await pendingKnocks(request.params.id) }),
  })

  route({
    route: 'POST /meetings/:id/knocks/:requestId',
    auth: { action: 'manage' },
    tags: ['meetings'],
    summary: 'Впустить гостя или отказать',
    handler: async (request) => {
      const decided = await decideKnock(
        request.params.id,
        request.params.requestId,
        request.body.admit,
      )
      if (!decided) throw errors.notFound('Заявка')
      return { ok: true as const }
    },
  })

  route({
    route: 'POST /meetings/:id/decline',
    auth: { action: 'join' },
    tags: ['meetings'],
    summary: 'Отклонить входящий звонок: звонящий узнаёт сразу',
    handler: async (request) => {
      await db().transaction((tx) => MeetingService.decline(tx, request.ctx, request.params.id))
      return { ok: true as const }
    },
  })
}
