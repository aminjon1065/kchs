import {
  MeetingGuestJoin,
  MeetingGuestJoinInput,
  MeetingGuestLink,
  MeetingGuestLinkInput,
  MeetingGuestPreview,
} from '@kchs/contracts'
import { z } from 'zod'
import { emitToRoom, emitToUser } from '~/kernel/realtime/gateway.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { createGuestLink, readGuestLink } from '../domain/guest-links.js'
import { mediaConfig, requireMedia } from '../domain/livekit.js'
import { MeetingService } from '../domain/meeting-service.js'
import { knock, knockState } from '../domain/waiting-room.js'

const IdParam = z.object({ id: z.uuid() })
/** Токен ссылки: `<встреча>.<срок>.<подпись>` — только безопасные символы. */
const TokenParam = z.object({ token: z.string().min(40).max(200) })

/**
 * Гостевой вход по ссылке (11-communications-meetings.md §3, ADR-0091).
 * Гость не становится пользователем системы: ссылка называет встречу, впускает
 * организатор, а токен комнаты не даёт доступа ни к одному объекту.
 */
export function registerMeetingsGuestRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/meetings/:id/guest-link',
    auth: { action: 'share' },
    tags: ['meetings'],
    summary: 'Ссылка для гостя: ограниченный срок, вход через комнату ожидания',
    schema: {
      params: IdParam,
      body: MeetingGuestLinkInput,
      response: { 200: MeetingGuestLink },
    },
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
    method: 'GET',
    url: '/meetings/guest/:token',
    auth: 'public',
    tags: ['meetings'],
    summary: 'Встреча по гостевой ссылке: название и состояние, без объектов',
    // Подбор подписи ограничивается по адресу: страница гостя открывается редко
    rateLimit: { max: 30, timeWindow: '1 minute' },
    schema: { params: TokenParam, response: { 200: MeetingGuestPreview } },
    handler: async (request) => preview(request.params.token),
  })

  route({
    method: 'POST',
    url: '/meetings/guest/:token/join',
    auth: 'public',
    tags: ['meetings'],
    summary: 'Гость просится в комнату; впущенному выдаётся короткий токен',
    rateLimit: { max: 60, timeWindow: '1 minute' },
    schema: {
      params: TokenParam,
      body: MeetingGuestJoinInput,
      response: { 200: MeetingGuestJoin },
    },
    handler: async (request) => {
      const link = readGuestLink(request.params.token)
      if (!link) throw errors.notFound('Ссылка недействительна')
      const meeting = await preview(request.params.token)
      const meetingId = link.meetingId

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
      const row = await MeetingService.load(db(), meetingId)
      // Ведущий видит стучащегося сразу: в открытой комнате и в списке встреч
      emitToRoom(`object:${meetingId}`, 'meeting.knock', { meetingId, requestId })
      if (row?.organizerId) {
        emitToUser(row.organizerId, 'meeting.knock', { meetingId, requestId })
      }
      return { state: 'waiting' as const, requestId, meeting, join: null }
    },
  })
}

/** Название и состояние встречи по ссылке: больше гостю знать не нужно. */
async function preview(token: string): Promise<{
  title: string
  status: 'planned' | 'live' | 'ended' | 'cancelled'
  enabled: boolean
}> {
  const link = readGuestLink(token)
  if (!link) throw errors.notFound('Ссылка недействительна')
  const row = await MeetingService.load(db(), link.meetingId)
  if (!row) throw errors.notFound('Встреча')
  return {
    title: row.title,
    status: row.status as 'planned' | 'live' | 'ended' | 'cancelled',
    enabled: mediaConfig() !== null,
  }
}
