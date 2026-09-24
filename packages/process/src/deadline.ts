/**
 * Часовые сроки шагов (ADR-0131): момент срока — активация шага плюс N
 * календарных часов, без производственного календаря — экстренный маршрут не
 * ждёт выходных. Напоминание — за час до срока, а если на шаг меньше двух
 * часов — посередине. Дневные сроки считает ядро по производственному календарю.
 */
const HOUR = 3_600_000

/** Момент срока: активация шага плюс `hours` календарных часов. */
export function hoursDeadline(activatedAt: Date | string, hours: number): Date {
  return new Date(new Date(activatedAt).getTime() + hours * HOUR)
}

/** Напоминание о часовом сроке: за час, если на шаг не меньше двух часов, иначе посередине. */
export function hoursReminder(activatedAt: Date | string, dueAt: Date | string): Date {
  const start = new Date(activatedAt).getTime()
  const end = new Date(dueAt).getTime()
  return new Date(end - start >= 2 * HOUR ? end - HOUR : start + (end - start) / 2)
}
