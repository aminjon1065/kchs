import { CalendarSettings, type CalendarSettingsInput, type WorkingHours } from '@kchs/contracts'
import { SettingsService } from '~/kernel/settings/service.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'

/** Ключ пользовательской настройки календаря. */
const KEY = 'calendar.settings'

/**
 * Настройки календаря пользователя (рабочие часы, напоминания по умолчанию,
 * отметки календарей) — пользовательская настройка ядра; повреждённое значение
 * заменяется умолчаниями.
 */
export async function calendarSettings(userId: string): Promise<CalendarSettings> {
  const stored = await SettingsService.get<unknown>(KEY, [{ scope: 'user', scopeId: userId }], {})
  const parsed = CalendarSettings.safeParse(stored ?? {})
  return parsed.success ? parsed.data : CalendarSettings.parse({})
}

export async function saveCalendarSettings(
  tx: Executor,
  ctx: Ctx,
  userId: string,
  patch: CalendarSettingsInput,
): Promise<CalendarSettings> {
  const current = await calendarSettings(userId)
  const parsed = CalendarSettings.safeParse({ ...current, ...patch })
  if (!parsed.success) throw errors.validation('Настройки календаря заданы неверно')
  await SettingsService.set(tx, ctx, 'user', userId, KEY, parsed.data, { silent: true })
  return parsed.data
}

/** Рабочие часы участников подбора времени. */
export async function workingHoursOf(userIds: string[]): Promise<Map<string, WorkingHours>> {
  const result = new Map<string, WorkingHours>()
  for (const userId of userIds) result.set(userId, (await calendarSettings(userId)).workingHours)
  return result
}
