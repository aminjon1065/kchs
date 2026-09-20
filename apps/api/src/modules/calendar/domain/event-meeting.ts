import {
  endMeeting,
  ensureMeetingForEvent,
  setMeetingParticipants,
} from '~/modules/meetings/public.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'

/**
 * Онлайн-встреча события календаря (ADR-0089). Встречу заводит календарь:
 * он знает организатора, участников и время; модуль встреч в его таблицы не
 * смотрит, обратная ссылка `events.meeting_id` остаётся здесь.
 */
export interface EventMeetingSync {
  eventId: string
  /** Текущая встреча события. */
  meetingId: string | null
  /** Чего хочет правка: включить, выключить или не трогать. */
  wanted: boolean | undefined
  title: string
  organizerId: string | null
  participantIds: readonly string[]
  startsAt: string | null
  endsAt: string | null
}

export async function syncEventMeeting(
  tx: Executor,
  ctx: Ctx,
  input: EventMeetingSync,
): Promise<{ meetingId: string | null; changed: boolean }> {
  if (input.wanted === true && !input.meetingId) {
    const meetingId = await ensureMeetingForEvent(tx, ctx, {
      eventId: input.eventId,
      title: input.title,
      organizerId: input.organizerId,
      participantIds: input.participantIds,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    })
    return { meetingId, changed: true }
  }
  if (input.wanted === false && input.meetingId) {
    await endMeeting(tx, ctx, input.meetingId, 'cancelled')
    return { meetingId: null, changed: true }
  }
  if (input.meetingId) {
    await setMeetingParticipants(tx, ctx, input.meetingId, input.participantIds)
  }
  return { meetingId: input.meetingId, changed: false }
}

/** Событие отменено или удалено — встреча закрывается для всех. */
export async function cancelEventMeeting(
  tx: Executor,
  ctx: Ctx,
  meetingId: string | null,
): Promise<void> {
  if (meetingId) await endMeeting(tx, ctx, meetingId, 'cancelled')
}
