/**
 * Публичный API модуля «Календарь» для других модулей (01-overview.md §Как
 * модули взаимодействуют, ADR-0081): реестр проекций. Модуль, у объектов
 * которого есть сроки (задачи и поручения, документы на контроле, формы
 * сбора), регистрирует поставщика — календарь показывает их как виртуальные
 * события. Файл не тянет за собой сервисы календаря: модули задач и документов
 * импортируют его без цикла зависимостей.
 */
import { EventCreateInput } from '@kchs/contracts'
import type { UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { EventService } from './domain/event-service.js'

export {
  type CalendarProjectionProvider,
  type ProjectedItem,
  type ProjectionRange,
  registerCalendarProjection,
} from './domain/projections.js'

/**
 * Событие календаря из другого модуля (16-api-and-events.md §4): правило
 * автоматизации создаёт встречу или напоминание в личном календаре
 * служебного пользователя или в указанном календаре. Права проверяет служба
 * календаря: писать можно только в доступный `ctx` календарь.
 * @public — правила автоматизации (действие `create_event`, ADR-0096)
 */
export const CalendarPublic = {
  createEvent: (
    tx: Executor,
    ctx: UserCtx,
    input: {
      title: string
      startsAt: string
      endsAt: string
      calendarId?: string | null
      participantIds?: readonly string[]
      description?: string | null
    },
  ): Promise<string> =>
    EventService.create(
      tx,
      ctx,
      EventCreateInput.parse({
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        ...(input.calendarId ? { calendarId: input.calendarId } : {}),
        ...(input.description ? { description: input.description } : {}),
        attendees: (input.participantIds ?? []).map((userId) => ({ userId })),
      }),
    ),
}
