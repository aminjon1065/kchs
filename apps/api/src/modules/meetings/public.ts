/**
 * Публичный API модуля «Встречи» для других модулей (01-overview.md §Как
 * модули взаимодействуют, ADR-0089). Встречу заводит тот, кто ею
 * распоряжается: чат — звонок из беседы. Встречу события календаря модуль
 * заводит как поставщик онлайн-встречи календаря (ADR-0181, `module.ts`). Сам
 * модуль встреч в чужие таблицы не ходит: событие и беседа приходят
 * идентификаторами.
 */
import type { UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { MeetingService } from './domain/meeting-service.js'

/**
 * Звонок из беседы (11-communications-meetings.md §1, ADR-0090): чат зовёт
 * встречи, встречи о чате не знают. Участники получают входящий звонок
 * событием `call.incoming`; беседа передаётся идентификатором.
 */
export const startCall = (
  tx: Executor,
  ctx: UserCtx,
  input: { title: string; conversationId: string; participantIds: readonly string[] },
): Promise<string> =>
  MeetingService.startCall(tx, ctx, {
    title: input.title,
    conversationId: input.conversationId,
    participantIds: [...input.participantIds],
  })
