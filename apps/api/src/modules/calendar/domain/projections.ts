import type { CalendarProjectionItem, CalendarProjectionSource } from '@kchs/contracts'
import type { UserCtx } from '~/shared/context.js'

/**
 * Реестр проекций календаря (12-calendar-notifications-home.md §1, ADR-0081):
 * сроки задач и поручений, сроки документов на контроле, дедлайны форм — это
 * виртуальные события других модулей. Календарь их не хранит и модули не
 * импортирует: модуль сам регистрирует поставщика при старте через
 * `modules/calendar/public.ts` (так нет цикла зависимостей).
 */

export interface ProjectionRange {
  from: Date
  to: Date
  /** Пояс смотрящего: дата срока — в нём. */
  timezone: string
}

/** Виртуальное событие поставщика: ключ и имя поставщика добавит календарь. */
export type ProjectedItem = Omit<CalendarProjectionItem, 'key' | 'provider'>

export interface CalendarProjectionProvider {
  /** Ключ проекции: `tasks.due`, `documents.control`. */
  key: string
  /** Подпись переключателя в левой колонке календаря (ключ словаря). */
  labelKey: string
  /** Иконка Lucide. */
  icon: string
  /**
   * Сроки в диапазоне `[from, to)`, касающиеся смотрящего, — только объекты,
   * которые он видит (предикат видимости ядра).
   */
  list: (ctx: UserCtx, range: ProjectionRange) => Promise<ProjectedItem[]>
}

const providers = new Map<string, CalendarProjectionProvider>()

export function registerCalendarProjection(provider: CalendarProjectionProvider): void {
  if (providers.has(provider.key)) {
    throw new Error(`Проекция календаря «${provider.key}» уже зарегистрирована`)
  }
  providers.set(provider.key, provider)
}

export function projectionProviders(): CalendarProjectionProvider[] {
  return [...providers.values()]
}

export function projectionSources(): CalendarProjectionSource[] {
  return projectionProviders().map(({ key, labelKey, icon }) => ({ key, labelKey, icon }))
}
