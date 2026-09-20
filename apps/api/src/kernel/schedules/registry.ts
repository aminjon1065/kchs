import type { QueueName } from '@kchs/contracts'

/**
 * Единый планировщик платформы (14-automation-integrations.md §2, ADR-0096).
 * Регулярные задания объявляются здесь, а не ставятся в очередь напрямую:
 * администратор видит их на экране «Расписания» с ближайшим запуском и
 * историей и может выключить проверку, не трогая код.
 *
 * Правила по cron живут в своём реестре (модуль `automation`) — планировщик
 * один, но состояние правила ведёт правило.
 */
export interface ScheduleDefinition {
  /** Ключ расписания: `<очередь>:<задание>`. */
  key: string
  queue: QueueName
  name: string
  /** Выражение cron из пяти полей. */
  pattern: string
  /** Ключ словаря с подписью для экрана «Расписания». */
  labelKey: string
  data?: Record<string, unknown>
}

const declared = new Map<string, ScheduleDefinition>()

export const scheduleKey = (queue: QueueName, name: string) => `${queue}:${name}`

/** Объявляет регулярное задание. Идемпотентно: повтор с теми же полями не ошибка. */
export function declareSchedule(input: Omit<ScheduleDefinition, 'key'>): ScheduleDefinition {
  const key = scheduleKey(input.queue, input.name)
  const existing = declared.get(key)
  if (existing) {
    if (existing.pattern !== input.pattern) {
      throw new Error(`Расписание ${key} уже объявлено с другим выражением`)
    }
    return existing
  }
  const definition: ScheduleDefinition = { key, ...input }
  declared.set(key, definition)
  return definition
}

export function listSchedules(): ScheduleDefinition[] {
  return [...declared.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export function scheduleDefinition(key: string): ScheduleDefinition | undefined {
  return declared.get(key)
}
