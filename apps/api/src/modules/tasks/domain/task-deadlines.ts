import type { TaskEscalationSettings } from '@kchs/contracts'
import {
  addDays,
  countWorkingDays,
  type DayKindOf,
  localDate,
  shiftWorkingDays,
  startOfLocalDay,
} from '~/kernel/business-calendar/working-days.js'

/**
 * Сроки поручений по производственному календарю (10-tasks-projects.md §4,
 * ADR-0082): напоминания за 3 и за 1 рабочий день и в день срока, просрочка и
 * эскалация руководителю исполнителя. Чистые функции — моменты этапов считаются
 * в поясе установки над исключениями календаря, которые подаёт вызывающий.
 */

/** Этапы: напоминания до срока, просрочка, эскалация. */
export const REMINDER_STAGES = ['d3', 'd1', 'today', 'overdue', 'escalated'] as const
export type ReminderStage = (typeof REMINDER_STAGES)[number]

/** Напоминания до срока — по порядку наступления. */
export const BEFORE_DUE_STAGES = ['d3', 'd1', 'today'] as const

/** Начало рабочего дня: напоминания и просрочка приходят утром, а не ночью. */
export const WORKDAY_START_HOUR = 9

/** Эскалация по умолчанию: через рабочий день после срока. */
export const DEFAULT_ESCALATION: TaskEscalationSettings = { enabled: true, afterWorkingDays: 1 }

const HOUR_MS = 3_600_000

/** Утро дня `day` в поясе установки — момент, когда этап наступает. */
export function workdayMorning(day: string, timezone: string): Date {
  return new Date(startOfLocalDay(day, timezone).getTime() + WORKDAY_START_HOUR * HOUR_MS)
}

export interface StageMoments {
  /** День срока в поясе установки. */
  dueDate: string
  d3: Date
  d1: Date
  today: Date
  overdue: Date
  escalated: Date
}

/**
 * Моменты этапов для срока: утро третьего и первого рабочих дней до дня срока,
 * утро дня срока; просрочка — утро следующего рабочего дня (срок — конец дня);
 * эскалация — ещё через `afterWorkingDays` рабочих дней (0 — вместе с просрочкой).
 */
export function stageMoments(
  dueAt: Date,
  timezone: string,
  kindOf: DayKindOf,
  escalation: TaskEscalationSettings = DEFAULT_ESCALATION,
): StageMoments {
  const dueDate = localDate(dueAt, timezone)
  const morning = (day: string) => workdayMorning(day, timezone)
  const overdueDay = shiftWorkingDays(dueDate, 1, kindOf)
  // Срок посреди дня: просрочка — не раньше самого срока
  const overdue = new Date(Math.max(morning(overdueDay).getTime(), dueAt.getTime() + 1))
  const escalationDay = shiftWorkingDays(overdueDay, escalation.afterWorkingDays, kindOf)
  return {
    dueDate,
    d3: morning(shiftWorkingDays(dueDate, -3, kindOf)),
    d1: morning(shiftWorkingDays(dueDate, -1, kindOf)),
    today: morning(dueDate),
    overdue,
    escalated: new Date(Math.max(morning(escalationDay).getTime(), overdue.getTime())),
  }
}

export interface DeadlineFacts {
  dueAt: Date
  /** Когда установлен действующий срок: более ранние напоминания не отправляются. */
  dueSetAt: Date
  /** Этапы, уже отправленные (или пропущенные) для этого срока. */
  done: ReadonlySet<ReminderStage>
}

export interface StagePlan {
  /** Этапы, которые отправляются сейчас. */
  fire: ReminderStage[]
  /** Наступившие, но устаревшие этапы: отмечаются без отправки. */
  skip: ReminderStage[]
  /** Рабочих дней до дня срока (0 — срок сегодня, меньше нуля — прошёл). */
  workingDaysLeft: number
}

/**
 * Что отправить сейчас. До срока — только последний наступивший этап: если
 * воркер стоял, человек не получит «осталось 3 дня» в день срока; этап, момент
 * которого раньше установки срока, не наступает вовсе (о сроке сообщило
 * назначение). Просрочка и эскалация — по наступлении, пока поручение открыто.
 */
export function planStages(
  facts: DeadlineFacts,
  now: Date,
  timezone: string,
  kindOf: DayKindOf,
  escalation: TaskEscalationSettings = DEFAULT_ESCALATION,
): StagePlan {
  const moments = stageMoments(facts.dueAt, timezone, kindOf, escalation)
  const fire: ReminderStage[] = []
  const skip: ReminderStage[] = []
  const at = now.getTime()

  if (at < facts.dueAt.getTime()) {
    const due = BEFORE_DUE_STAGES.filter(
      (stage) =>
        !facts.done.has(stage) &&
        moments[stage].getTime() <= at &&
        moments[stage].getTime() >= facts.dueSetAt.getTime(),
    )
    const latest = due[due.length - 1]
    if (latest) {
      fire.push(latest)
      skip.push(...due.slice(0, -1))
    }
  }
  if (!facts.done.has('overdue') && at >= moments.overdue.getTime()) fire.push('overdue')
  if (escalation.enabled && !facts.done.has('escalated') && at >= moments.escalated.getTime()) {
    fire.push('escalated')
  }
  return {
    fire,
    skip,
    workingDaysLeft: countWorkingDays(localDate(now, timezone), moments.dueDate, kindOf),
  }
}

/**
 * Промежуток дат, исключения календаря которого нужны этапам сроков: от трёх
 * рабочих дней до срока до эскалации после него — с запасом на праздники.
 */
export function calendarSpan(
  dueAts: readonly Date[],
  timezone: string,
  escalation: TaskEscalationSettings = DEFAULT_ESCALATION,
): { from: string; to: string } | null {
  if (dueAts.length === 0) return null
  const days = dueAts.map((due) => localDate(due, timezone)).sort()
  const first = days[0] as string
  const last = days[days.length - 1] as string
  return { from: addDays(first, -30), to: addDays(last, 30 + escalation.afterWorkingDays * 2) }
}
