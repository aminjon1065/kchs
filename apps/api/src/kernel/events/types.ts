import type { EventEnvelope } from '@kchs/contracts'

/** Данные, из которых ядро собирает конверт события. */
export interface EventInput {
  type: string
  version?: number
  object?: { id: string; type: string; spaceId?: string | null; title?: string | null } | null
  target?: { id: string; type: string; spaceId?: string | null; title?: string | null } | null
  payload?: Record<string, unknown>
  changedFields?: string[] | null
  correlationId?: string | null
  causationId?: string | null
  source?: string
}

export type EventHandler = (event: EventEnvelope) => Promise<void>

export interface Subscriber {
  /** Уникальное имя consumer group. */
  name: string
  /** Типы событий: точное имя или префикс с `*` (`object.*`). */
  types: string[]
  handle: EventHandler
  /** Сколько раз повторять до DLQ. */
  maxAttempts?: number
  /**
   * Новая группа читает поток с начала (ADR-0171). Без флага подписчик,
   * добавленный в обновлении работающей установки, начинает с новых событий —
   * иначе он разослал бы уведомления по всей сохранённой истории. Флаг — у
   * проекций, которым история полезна и повтор безвреден (поисковые индексы).
   */
  replay?: boolean
  /**
   * Проекция (ADR-0228): событие, ушедшее в DLQ после всех попыток (поиск был
   * недоступен дольше минуты), возвращается в поток само — заданием
   * `events.redrive`, а не руками администратора. Только у идемпотентных
   * подписчиков, которым повтор безвреден.
   */
  redrive?: boolean
}
