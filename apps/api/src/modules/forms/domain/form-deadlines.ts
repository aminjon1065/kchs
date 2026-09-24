import type { FormDueMode, FormEscalation } from '@kchs/contracts'
import {
  addDays,
  type DayKindOf,
  localDate,
  shiftWorkingDays,
  startOfLocalDay,
} from '~/kernel/business-calendar/working-days.js'

/**
 * Этапы контроля сдачи (06-analytics-engine.md §13, ADR-0103) — чистые функции.
 * Напоминание приходит утром дня срока, просрочка — по его наступлении,
 * эскалация руководителю — через заданное число рабочих дней после срока.
 * Правило то же, что у поручений (ADR-0082), но этапов три: сводку сдают
 * коротким циклом, и «за 3 дня» для ежедневной формы бессмысленно.
 *
 * Календарные сроки (ADR-0129) — дежурный цикл без выходных: напоминание за
 * два часа до срока, просрочка в срок, эскалация через час после него или
 * через N календарных дней в 09:00.
 */

export const FORM_STAGES = ['due_soon', 'overdue', 'escalated'] as const
export type FormStage = (typeof FORM_STAGES)[number]

/** Утро дня: напоминания приходят к началу рабочего дня, а не ночью. */
const MORNING_HOUR = 9
const HOUR_MS = 3_600_000
/** Календарные сроки: напоминание за столько до срока. */
const CALENDAR_REMIND_BEFORE_MS = 2 * HOUR_MS
/** Календарные сроки без дней на эскалацию: через столько после срока. */
const CALENDAR_ESCALATE_AFTER_MS = HOUR_MS

export interface StageMoments {
  dueDate: string
  due_soon: Date
  overdue: Date
  escalated: Date
}

export function stageMoments(
  dueAt: Date,
  timezone: string,
  kindOf: DayKindOf,
  escalation: FormEscalation,
  mode: FormDueMode = 'working',
): StageMoments {
  const dueDate = localDate(dueAt, timezone)
  const morning = (day: string) =>
    new Date(startOfLocalDay(day, timezone).getTime() + MORNING_HOUR * HOUR_MS)
  if (mode === 'calendar') {
    const days = Math.max(escalation.afterWorkingDays, 0)
    const escalated =
      days === 0
        ? new Date(dueAt.getTime() + CALENDAR_ESCALATE_AFTER_MS)
        : new Date(Math.max(morning(addDays(dueDate, days)).getTime(), dueAt.getTime() + 1))
    return {
      dueDate,
      due_soon: new Date(dueAt.getTime() - CALENDAR_REMIND_BEFORE_MS),
      overdue: dueAt,
      escalated,
    }
  }
  const escalationDay = shiftWorkingDays(dueDate, Math.max(escalation.afterWorkingDays, 0), kindOf)
  const escalated = new Date(Math.max(morning(escalationDay).getTime(), dueAt.getTime() + 1))
  const dueDayMorning = morning(dueDate)
  return {
    dueDate,
    /**
     * Напоминание — утром того дня, когда наступает срок. Если срок раньше
     * начала рабочего дня («сводка к 08:00»), напоминать в этот день поздно:
     * оно уходит утром предыдущего рабочего дня.
     */
    due_soon:
      dueAt.getTime() > dueDayMorning.getTime()
        ? dueDayMorning
        : morning(shiftWorkingDays(dueDate, -1, kindOf)),
    overdue: dueAt,
    escalated,
  }
}

export interface StagePlan {
  fire: FormStage[]
  /** Наступившие, но устаревшие этапы: отмечаются без отправки. */
  skip: FormStage[]
}

/**
 * Что отправить сейчас. Напоминание до срока не шлётся, если срок уже прошёл:
 * воркер мог стоять, и «сдайте сегодня» после просрочки только путает.
 */
export function planStages(
  facts: { dueAt: Date; done: ReadonlySet<FormStage> },
  now: Date,
  timezone: string,
  kindOf: DayKindOf,
  escalation: FormEscalation,
  mode: FormDueMode = 'working',
): StagePlan {
  const moments = stageMoments(facts.dueAt, timezone, kindOf, escalation, mode)
  const at = now.getTime()
  const fire: FormStage[] = []
  const skip: FormStage[] = []

  if (!facts.done.has('due_soon') && at >= moments.due_soon.getTime()) {
    if (at < moments.overdue.getTime()) fire.push('due_soon')
    else skip.push('due_soon')
  }
  if (!facts.done.has('overdue') && at >= moments.overdue.getTime()) fire.push('overdue')
  if (escalation.enabled && !facts.done.has('escalated') && at >= moments.escalated.getTime()) {
    fire.push('escalated')
  }
  return { fire, skip }
}
