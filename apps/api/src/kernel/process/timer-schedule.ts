import { hoursDeadline, hoursReminder, type StepDeadline } from '@kchs/process'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { BusinessCalendar } from '../business-calendar/service.js'
import { endOfLocalDay, localDate, startOfLocalDay } from '../business-calendar/working-days.js'
import { JobService } from '../jobs/service.js'
import type { StepTimers } from './store.js'

/**
 * Таймеры шагов (ADR-0079): моменты хранятся в строке шага (`timers`,
 * ближайший — `next_timer_at`), срабатывание — отложенное задание очереди
 * `process-timers`, которое перечитывает состояние из базы. Задание на шаг одно —
 * на ближайший момент; обработчик ставит следующее.
 */
export const TIMER_JOB = 'process.timer'

/** Напоминания приходят к началу рабочего дня. */
const REMINDER_HOUR = 9

function morningOf(day: string, timezone: string): Date {
  return new Date(startOfLocalDay(day, timezone).getTime() + REMINDER_HOUR * 3_600_000)
}

/**
 * Момент срока шага от активации: рабочие дни — конец N-го рабочего дня по
 * производственному календарю, часы — ровно через N календарных часов (ADR-0131).
 */
export async function deadlineAt(tx: Executor, from: Date, deadline: StepDeadline): Promise<Date> {
  if (deadline.unit === 'hours') return hoursDeadline(from, deadline.value)
  return (await BusinessCalendar.deadline(from, deadline.value, { executor: tx })).dueAt
}

/**
 * Таймеры часового срока (ADR-0131): одно напоминание — за час до срока, а у
 * срока короче двух часов посередине, — и просрочка в момент срока. Прошедший
 * момент напоминания не ставится.
 */
export function hourTimers(activatedAt: string, dueAt: string, now: Date): StepTimers {
  const timers: StepTimers = {}
  const remind = hoursReminder(activatedAt, dueAt)
  if (remind > now) timers.remindSoon = { at: remind.toISOString() }
  timers.overdue = { at: new Date(dueAt).toISOString() }
  return timers
}

/**
 * Таймеры дневного срока шага: напоминание за рабочий день и в день срока
 * (утром), просрочка — в конце дня срока. Прошедшие моменты не ставятся.
 */
export async function dueTimers(tx: Executor, dueAt: string, now: Date): Promise<StepTimers> {
  const timezone = config().TZ
  const due = new Date(dueAt)
  const dueDay = localDate(due, timezone)
  const dayBefore = await BusinessCalendar.addWorkingDays(dueDay, -1, { executor: tx })
  const timers: StepTimers = {}
  const before = morningOf(dayBefore, timezone)
  if (before > now) timers.remindBefore = { at: before.toISOString() }
  const onDay = morningOf(dueDay, timezone)
  if (onDay > now && onDay < due) timers.remindDue = { at: onDay.toISOString() }
  timers.overdue = { at: due.toISOString() }
  return timers
}

/** Момент ожидания `until`: дата — конец дня в поясе установки, момент — как есть. */
export function untilMoment(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return endOfLocalDay(value, config().TZ).toISOString()
  }
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** Ближайший несработавший таймер. */
export function nextTimerAt(timers: StepTimers): string | null {
  const pending = Object.values(timers)
    .filter((timer) => timer && !timer.firedAt)
    .map((timer) => timer?.at as string)
    .sort()
  return pending[0] ?? null
}

/**
 * Задание таймера — в транзакции шага, в очередь после коммита (ADR-0036).
 * Ключ идемпотентности — шаг и момент: повтор постановки не дублирует задание.
 */
export async function scheduleTimerJob(tx: Executor, stepId: string, at: string): Promise<void> {
  await JobService.schedule(tx, systemCtx('process.timer'), {
    queue: 'process-timers',
    name: TIMER_JOB,
    data: { stepId, at },
    idempotencyKey: `${TIMER_JOB}:${stepId}:${at}`,
    options: { delay: Math.max(0, Date.parse(at) - Date.now()), attempts: 5 },
  })
}
