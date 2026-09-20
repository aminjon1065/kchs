import {
  MeetingCreateInput,
  MeetingJoin,
  MeetingList,
  MeetingListQuery,
  MeetingRecord,
  MeetingsStatus,
} from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { mediaConfig } from './domain/livekit.js'
import { MeetingService } from './domain/meeting-service.js'

const IdParam = z.object({ id: z.uuid() })

/** Маршруты встреч и звонков (11-communications-meetings.md §3, ADR-0089). */
export function registerMeetingsRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/meetings/status',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Настроен ли медиасервер: без него кнопок звонка нет',
    schema: { response: { 200: MeetingsStatus } },
    handler: async () => {
      const media = mediaConfig()
      return { enabled: media !== null, url: media?.url ?? null }
    },
  })

  route({
    method: 'GET',
    url: '/meetings',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Встречи: мои, идущие или все доступные',
    schema: { querystring: MeetingListQuery, response: { 200: MeetingList } },
    handler: async (request) => ({ items: await MeetingService.list(request.ctx, request.query) }),
  })

  route({
    method: 'POST',
    url: '/meetings',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Поднять звонок: участники получают входящий',
    schema: { body: MeetingCreateInput, response: { 200: MeetingRecord } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        MeetingService.startCall(tx, request.ctx, request.body),
      )
      return MeetingService.get(request.ctx, id)
    },
  })

  route({
    method: 'GET',
    url: '/meetings/:id',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Встреча: участники, состояние, права',
    schema: { params: IdParam, response: { 200: MeetingRecord } },
    handler: async (request) => MeetingService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/meetings/:id/join',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Войти в комнату: адрес медиасервера и токен участника',
    schema: { params: IdParam, response: { 200: MeetingJoin } },
    handler: async (request) => MeetingService.join(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/meetings/:id/leave',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Выйти из комнаты',
    schema: { params: IdParam, response: { 200: z.object({ ok: z.literal(true) }) } },
    handler: async (request) => {
      await MeetingService.leave(request.ctx, request.params.id)
      return { ok: true as const }
    },
  })

  route({
    method: 'POST',
    url: '/meetings/:id/end',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Завершить встречу для всех',
    schema: { params: IdParam, response: { 200: MeetingRecord } },
    handler: async (request) => {
      await authorize(request.ctx, 'end', request.params.id)
      await db().transaction((tx) => MeetingService.end(tx, request.ctx, request.params.id))
      return MeetingService.get(request.ctx, request.params.id)
    },
  })
}
