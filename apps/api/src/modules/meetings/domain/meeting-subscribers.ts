import type { EventEnvelope } from '@kchs/contracts'
import { directory } from '~/kernel/directory/port.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom, emitToUser } from '~/kernel/realtime/gateway.js'

/**
 * Доставка событий встречи в realtime (ADR-0091, 16-api-and-events.md §3).
 * Медиапоток идёт мимо api, поэтому шлюз сообщает клиенту только факты:
 * входящий звонок приглашённому, отказ — звонящему, смена состава и
 * завершение — всем, у кого открыта комната.
 */
export function registerMeetingRealtime(): void {
  registerSubscriber({
    name: 'meetings-realtime',
    types: [
      'call.incoming',
      'call.declined',
      'meeting.started',
      'meeting.ended',
      'meeting.participant_joined',
      'meeting.participant_left',
      // Секретарь сменился: карточка и протокол у открывших обновляются (N30)
      'meeting.secretary_changed',
    ],
    handle: handleMeetingEvent,
  })
}

async function handleMeetingEvent(event: EventEnvelope): Promise<void> {
  const meetingId = event.object?.id
  if (!meetingId) return
  const payload = (event.payload ?? {}) as Record<string, unknown>

  if (event.type === 'call.incoming') {
    await ringInvited(event, meetingId, payload)
    return
  }

  if (event.type === 'call.declined') {
    const callerId = typeof payload.callerId === 'string' ? payload.callerId : null
    if (callerId) {
      emitToUser(callerId, 'call.declined', { meetingId, userId: payload.userId ?? null })
    }
    return
  }

  // Состав и состояние комнаты: у кого встреча открыта, тот видит это сразу.
  // Комната объекта — та же, что у обсуждения и присутствия: права проверены
  // при подписке
  emitToRoom(`object:${meetingId}`, 'meeting.changed', {
    meetingId,
    change: event.type.slice('meeting.'.length),
  })
}

/** Входящий звонок: экран у приглашённого и уведомление в списке. */
async function ringInvited(
  event: EventEnvelope,
  meetingId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const userIds = Array.isArray(payload.userIds) ? (payload.userIds as string[]) : []
  if (userIds.length === 0) return
  const callerId = typeof payload.callerId === 'string' ? payload.callerId : null
  const caller = callerId ? ((await directory().refs([callerId])).get(callerId) ?? null) : null
  const title = event.object?.title ?? ''
  for (const userId of userIds) {
    if (userId === callerId) continue
    emitToUser(userId, 'call.incoming', {
      meetingId,
      title,
      caller,
      conversationId: payload.conversationId ?? null,
    })
  }
  // Звонок срочен: уведомление приходит сразу, минуя дайджест
  await NotificationService.notify({
    userIds,
    category: 'meetings',
    titleKey: 'notifications.tpl.callIncoming',
    objectId: meetingId,
    actorId: callerId,
    url: `/o/${meetingId}`,
    params: { actor: caller?.displayName ?? '', title },
    channels: ['app'],
    urgent: true,
  })
}
