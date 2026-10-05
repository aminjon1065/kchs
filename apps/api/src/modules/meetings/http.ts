import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { mediaConfig } from './domain/livekit.js'
import { MeetingService } from './domain/meeting-service.js'
import { registerProtocolRoutes } from './http/protocol-routes.js'

/** Маршруты встреч и звонков (11-communications-meetings.md §3, ADR-0089). */
export function registerMeetingsRoutes(route: RouteRegistrar): void {
  registerProtocolRoutes(route)

  route({
    route: 'GET /meetings/status',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Настроен ли медиасервер: без него кнопок звонка нет',
    handler: async () => {
      const media = mediaConfig()
      return { enabled: media !== null, url: media?.url ?? null }
    },
  })

  route({
    route: 'GET /meetings',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Встречи: мои, идущие или все доступные',
    handler: async (request) => ({ items: await MeetingService.list(request.ctx, request.query) }),
  })

  route({
    route: 'POST /meetings',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Поднять звонок: участники получают входящий',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        MeetingService.startCall(tx, request.ctx, request.body),
      )
      return MeetingService.get(request.ctx, id)
    },
  })

  route({
    route: 'GET /meetings/:id',
    auth: { delegated: 'MeetingService.get', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Встреча: участники, состояние, права',
    handler: async (request) => MeetingService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /meetings/:id/join',
    auth: { delegated: 'MeetingService.join', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Войти в комнату: адрес медиасервера и токен участника',
    handler: async (request) => MeetingService.join(request.ctx, request.params.id),
  })

  route({
    route: 'POST /meetings/:id/leave',
    auth: { delegated: 'MeetingService.leave', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Выйти из комнаты',
    handler: async (request) => {
      await MeetingService.leave(request.ctx, request.params.id)
      return { ok: true as const }
    },
  })

  route({
    route: 'PUT /meetings/:id/secretary',
    auth: { delegated: 'MeetingService.setSecretary', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Назначить или снять секретаря встречи: он правит протокол (ADR-0137)',
    handler: async (request) => {
      await MeetingService.setSecretary(request.ctx, request.params.id, request.body.userId)
      return MeetingService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /meetings/:id/end',
    auth: { delegated: 'authorize(end)', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Завершить встречу для всех',
    handler: async (request) => {
      await authorize(request.ctx, 'end', request.params.id)
      await db().transaction((tx) => MeetingService.end(tx, request.ctx, request.params.id))
      return MeetingService.get(request.ctx, request.params.id)
    },
  })
}
