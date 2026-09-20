import { MeetingKnockDecision, MeetingKnockList } from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { MeetingService } from '../domain/meeting-service.js'
import { decideKnock, pendingKnocks } from '../domain/waiting-room.js'

const IdParam = z.object({ id: z.uuid() })
const KnockParams = z.object({ id: z.uuid(), requestId: z.uuid() })

/**
 * Комната ожидания и входящий звонок (ADR-0091): решение по заявке принимает
 * тот, кто ведёт встречу (`manage`), отклонить звонок может приглашённый.
 */
export function registerMeetingsRoomRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/meetings/:id/knocks',
    auth: { action: 'manage' },
    tags: ['meetings'],
    summary: 'Кто ждёт в комнате ожидания',
    schema: { params: IdParam, response: { 200: MeetingKnockList } },
    handler: async (request) => ({ items: await pendingKnocks(request.params.id) }),
  })

  route({
    method: 'POST',
    url: '/meetings/:id/knocks/:requestId',
    auth: { action: 'manage' },
    tags: ['meetings'],
    summary: 'Впустить гостя или отказать',
    schema: {
      params: KnockParams,
      body: MeetingKnockDecision,
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
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
    method: 'POST',
    url: '/meetings/:id/decline',
    auth: { action: 'join' },
    tags: ['meetings'],
    summary: 'Отклонить входящий звонок: звонящий узнаёт сразу',
    schema: { params: IdParam, response: { 200: z.object({ ok: z.literal(true) }) } },
    handler: async (request) => {
      await db().transaction((tx) => MeetingService.decline(tx, request.ctx, request.params.id))
      return { ok: true as const }
    },
  })
}
