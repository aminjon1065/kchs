/**
 * Публичный API модуля «Встречи» для других модулей (01-overview.md §Как
 * модули взаимодействуют, ADR-0089). Встречу заводит тот, кто ею
 * распоряжается: календарь — для события с онлайн-встречей (звонок из беседы
 * чат добавит сюда своей веткой). Сам модуль встреч в чужие таблицы не ходит:
 * событие и беседа приходят идентификаторами.
 */
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { MeetingService } from './domain/meeting-service.js'

export interface EventMeetingInput {
  eventId: string
  title: string
  organizerId: string | null
  participantIds: readonly string[]
  startsAt: string | null
  endsAt: string | null
}

/** Встреча события календаря: создаётся один раз, дальше только обновляется. */
export const ensureMeetingForEvent = async (
  tx: Executor,
  ctx: Ctx,
  input: EventMeetingInput,
): Promise<string> =>
  MeetingService.create(tx, ctx, {
    kind: 'scheduled',
    title: input.title,
    eventId: input.eventId,
    organizerId: input.organizerId,
    participantIds: input.participantIds,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  })

/** Состав участников встречи изменился у события — синхронизировать. */
export const setMeetingParticipants: typeof MeetingService.setParticipants = (
  tx,
  ctx,
  meetingId,
  userIds,
) => MeetingService.setParticipants(tx, ctx, meetingId, userIds)

/** Событие отменено или удалено — встреча закрывается. */
export const endMeeting = (
  tx: Executor,
  ctx: Ctx,
  meetingId: string,
  reason: 'manual' | 'empty' | 'cancelled' = 'cancelled',
): Promise<void> => MeetingService.end(tx, ctx, meetingId, reason)
