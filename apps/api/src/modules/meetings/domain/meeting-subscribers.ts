import type { EventEnvelope, EventPayload, MeetingChange } from '@kchs/contracts'
import { directory } from '~/kernel/directory/port.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom, emitToUser } from '~/kernel/realtime/gateway.js'

/** Что случилось с комнатой — по событию встречи (протокол realtime, ADR-0192). */
const MEETING_CHANGE: Record<string, MeetingChange> = {
  'meeting.started': 'started',
  'meeting.ended': 'ended',
  'meeting.participant_joined': 'participant_joined',
  'meeting.participant_left': 'participant_left',
  'meeting.secretary_changed': 'secretary_changed',
}

/**
 * Доставка событий встречи в realtime (ADR-0091, 16-api-and-events.md §3).
 * Медиапоток идёт мимо api, поэтому шлюз сообщает клиенту только факты:
 * входящий звонок приглашённому, смена состава и завершение — всем, у кого
 * открыта комната. Отказ от звонка (`call.declined`) остаётся событием шины:
 * сообщения звонящему нет, пока его некому показать (ADR-0192).
 */
export function registerMeetingRealtime(): void {
  registerSubscriber({
    name: 'meetings-realtime',
    types: [
      'call.incoming',
      ...Object.keys(MEETING_CHANGE),
      // Расшифровку поправили: у открывших запись она перечитывается (ADR-0162)
      'transcript.edited',
    ],
    handle: handleMeetingEvent,
  })
}

async function handleMeetingEvent(event: EventEnvelope): Promise<void> {
  const meetingId = event.object?.id
  if (!meetingId) return

  if (event.type === 'transcript.edited') {
    // Объект события — запись: её вкладка подписана на свою комнату
    emitToRoom(`object:${meetingId}`, 'object.updated', {
      id: meetingId,
      type: 'recording',
      version: 0,
      changedFields: ['transcript'],
      actorId: event.actor.userId,
    })
    return
  }

  if (event.type === 'call.incoming') {
    await ringInvited(event, meetingId, event.payload as EventPayload<'call.incoming'>)
    return
  }

  // Состав и состояние комнаты: у кого встреча открыта, тот видит это сразу.
  // Комната объекта — та же, что у обсуждения и присутствия: права проверены
  // при подписке. Секретарь сменился — карточка и протокол обновляются (N30)
  const change = MEETING_CHANGE[event.type]
  if (change) emitToRoom(`object:${meetingId}`, 'meeting.changed', { meetingId, change })
}

/** Входящий звонок: экран у приглашённого и уведомление в списке. */
async function ringInvited(
  event: EventEnvelope,
  meetingId: string,
  payload: EventPayload<'call.incoming'>,
): Promise<void> {
  const { userIds, callerId, conversationId } = payload
  if (userIds.length === 0) return
  const caller = callerId ? ((await directory().refs([callerId])).get(callerId) ?? null) : null
  const title = event.object?.title ?? ''
  for (const userId of userIds) {
    if (userId === callerId) continue
    emitToUser(userId, 'call.incoming', { meetingId, title, caller, conversationId })
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
