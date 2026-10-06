import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { createGuestLink, readGuestLink } from '../domain/guest-links.js'
import { mediaConfig, requireMedia } from '../domain/livekit.js'
import { MeetingService } from '../domain/meeting-service.js'
import { knock, knockState } from '../domain/waiting-room.js'

/**
 * Гостевой вход по ссылке (11-communications-meetings.md §3, ADR-0091).
 * Гость не становится пользователем системы: ссылка называет встречу, впускает
 * организатор, а токен комнаты не даёт доступа ни к одному объекту.
 */
export function registerMeetingsGuestRoutes(route: RouteRegistrar): void {
  route({
    route: 'POST /meetings/:id/guest-link',
    auth: { action: 'share' },
    tags: ['meetings'],
    summary: 'Ссылка для гостя: ограниченный срок, вход через комнату ожидания',
    handler: async (request) => {
      requireMedia()
      const row = await MeetingService.load(db(), request.params.id)
      if (!row) throw errors.notFound('Встреча')
      if (row.status === 'ended' || row.status === 'cancelled') {
        throw errors.conflict('Встреча завершена', { status: row.status })
      }
      const link = createGuestLink(row.id, request.body.ttlMinutes * 60)
      return { url: link.url, expiresAt: link.expiresAt }
    },
  })

  route({
    route: 'GET /meetings/guest/:token',
    auth: 'public',
    tags: ['meetings'],
    summary: 'Встреча по гостевой ссылке: название и состояние, без объектов',
    // Подбор подписи ограничивается по адресу: страница гостя открывается редко
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request) => previewOf(await linkedMeeting(request.params.token)),
  })

  route({
    route: 'POST /meetings/guest/:token/join',
    auth: 'public',
    tags: ['meetings'],
    summary: 'Гость просится в комнату; впущенному выдаётся короткий токен',
    rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async (request) => {
      const row = await linkedMeeting(request.params.token)
      const meeting = previewOf(row)
      const meetingId = row.id

      // Повторный заход по той же заявке: клиент ждёт решения или обновляет токен
      const existing = request.body.requestId
        ? await knockState(meetingId, request.body.requestId)
        : null
      if (existing?.state === 'denied') {
        return {
          state: 'denied' as const,
          requestId: request.body.requestId ?? '',
          meeting,
          join: null,
        }
      }
      if (existing?.state === 'admitted') {
        const join = await MeetingService.guestToken(meetingId, { name: existing.name })
        return {
          state: 'admitted' as const,
          requestId: request.body.requestId ?? '',
          meeting,
          join,
        }
      }
      if (existing?.state === 'waiting') {
        return {
          state: 'waiting' as const,
          requestId: request.body.requestId ?? '',
          meeting,
          join: null,
        }
      }

      if (!meeting.enabled) throw errors.unavailable('Медиасервер не настроен')
      const requestId = await knock(meetingId, request.body.name)
      // О госте сообщает событие: открытой комнате встречи — новой заявкой, ведущему — где бы
      // он ни был (ADR-0193). Гость не пользователь — событие от имени системы
      await db().transaction((tx) =>
        publishEvent(tx, systemCtx('meetings.guest_knock'), {
          type: 'meeting.guest_waiting',
          object: { id: meetingId, type: 'meeting', spaceId: null, title: row.title },
          payload: {
            meetingId,
            requestId,
            name: request.body.name,
            organizerId: row.organizerId,
          },
        }),
      )
      return { state: 'waiting' as const, requestId, meeting, join: null }
    },
  })
}

/** Встреча гостевой ссылки; недействительная ссылка и удалённая встреча — 404. */
async function linkedMeeting(token: string) {
  const link = readGuestLink(token)
  if (!link) throw errors.notFound('Ссылка недействительна')
  const row = await MeetingService.load(db(), link.meetingId)
  if (!row) throw errors.notFound('Встреча')
  return row
}

/** Название и состояние встречи по ссылке: больше гостю знать не нужно. */
function previewOf(row: NonNullable<Awaited<ReturnType<typeof MeetingService.load>>>): {
  title: string
  status: 'planned' | 'live' | 'ended' | 'cancelled'
  enabled: boolean
} {
  return {
    title: row.title,
    status: row.status as 'planned' | 'live' | 'ended' | 'cancelled',
    enabled: mediaConfig() !== null,
  }
}
