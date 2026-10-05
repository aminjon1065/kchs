import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'

/** Встреча, которую событие календаря заводит у поставщика. */
export interface EventMeetingInput {
  eventId: string
  title: string
  organizerId: string | null
  participantIds: readonly string[]
  startsAt: string | null
  endsAt: string | null
}

/**
 * Поставщик онлайн-встречи события (ADR-0181). Календарь знает организатора,
 * участников и время, а комнату заводит модуль встреч — он регистрируется здесь,
 * как поставщики проекций (`registerCalendarProjection`). Календарь встречи не
 * импортирует: слой модулей календаря ниже встреч, и кольца calendar → meetings →
 * documents → calendar нет.
 */
export interface OnlineMeetingProvider {
  /** Встреча события: создаётся один раз, дальше только обновляется. */
  ensureForEvent(tx: Executor, ctx: Ctx, input: EventMeetingInput): Promise<string>
  /** Состав участников события изменился — синхронизировать встречу. */
  setParticipants(
    tx: Executor,
    ctx: Ctx,
    meetingId: string,
    userIds: readonly string[],
  ): Promise<void>
  /** Событие отменено или удалено — встреча закрывается для всех. */
  cancel(tx: Executor, ctx: Ctx, meetingId: string): Promise<void>
}

let provider: OnlineMeetingProvider | null = null

/** Поставщика регистрирует модуль встреч вместе со своими типами объектов. */
export function registerOnlineMeetingProvider(next: OnlineMeetingProvider): void {
  provider = next
}

export function onlineMeetings(): OnlineMeetingProvider {
  if (!provider) throw errors.validation('Онлайн-встречи недоступны: модуль встреч не подключён')
  return provider
}
