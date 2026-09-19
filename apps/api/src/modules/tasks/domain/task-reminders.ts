import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { directory } from '~/kernel/directory/port.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, taskReminders, tasks } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { emit } from './task-core.js'
import { calendarSpan, planStages, type ReminderStage, type StagePlan } from './task-deadlines.js'
import { sameMoment } from './task-due.js'
import { TaskSettingsService } from './task-settings.js'

/** Кому напоминать: исполнитель ещё работает (после отчёта ход за автором). */
const WORKING_STATUSES = ['assigned', 'in_progress', 'returned']

/** Дальше этого срока напоминаний ещё нет: «за 3 рабочих дня» не раньше чем за две недели. */
const HORIZON_MS = 21 * 86_400_000

interface DueRow {
  id: string
  key: string
  title: string
  spaceId: string | null
  dueAt: string
  dueSetAt: string | null
  createdAt: string
  assigneeId: string | null
}

/**
 * Напоминания и эскалации поручений (10-tasks-projects.md §4, ADR-0082):
 * периодическое задание воркера. Идемпотентность — строка `task_reminders`
 * (поручение, этап, срок) вставляется в одной транзакции с событием: повтор
 * задания, два воркера или перезапуск не дают дублей, а новый срок (продление)
 * напоминает заново.
 */
export const TaskReminders = {
  async run(now: Date = new Date()): Promise<{ checked: number; fired: number }> {
    const timezone = config().TZ
    const { escalation } = await TaskSettingsService.current()
    const rows = (await db()
      .select({
        id: tasks.id,
        key: tasks.key,
        title: objects.title,
        spaceId: objects.spaceId,
        dueAt: tasks.dueAt,
        dueSetAt: tasks.dueSetAt,
        createdAt: objects.createdAt,
        assigneeId: tasks.assigneeId,
      })
      .from(tasks)
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(
        and(
          eq(tasks.kind, 'instruction'),
          inArray(tasks.status, WORKING_STATUSES),
          isNotNull(tasks.dueAt),
          lt(tasks.dueAt, new Date(now.getTime() + HORIZON_MS).toISOString()),
          sql`${objects.deletedAt} IS NULL`,
          sql`${objects.archivedAt} IS NULL`,
        ),
      )) as DueRow[]
    if (rows.length === 0) return { checked: 0, fired: 0 }

    const done = await doneStages(rows.map((row) => row.id))
    const span = calendarSpan(
      rows.map((row) => new Date(row.dueAt)),
      timezone,
      escalation,
    )
    const kindOf = span ? await BusinessCalendar.dayKinds(span.from, span.to) : () => undefined

    let fired = 0
    for (const row of rows) {
      const plan = planStages(
        {
          dueAt: new Date(row.dueAt),
          dueSetAt: new Date(row.dueSetAt ?? row.createdAt),
          done: done.get(stageKey(row.id, row.dueAt)) ?? new Set(),
        },
        now,
        timezone,
        kindOf,
        escalation,
      )
      if (plan.fire.length === 0 && plan.skip.length === 0) continue
      try {
        fired += await db().transaction((tx) => fire(tx, row, plan, escalation.afterWorkingDays))
      } catch (error) {
        // Одно поручение не останавливает остальные: повтор — при следующем проходе
        logger().warn({ err: error, taskId: row.id }, 'напоминание по поручению не отправлено')
      }
    }
    return { checked: rows.length, fired }
  },
}

const stageKey = (taskId: string, dueAt: string) => `${taskId}|${new Date(dueAt).getTime()}`

async function doneStages(taskIds: string[]): Promise<Map<string, Set<ReminderStage>>> {
  const rows = await db()
    .select({
      taskId: taskReminders.taskId,
      stage: taskReminders.stage,
      dueAt: taskReminders.dueAt,
    })
    .from(taskReminders)
    .where(inArray(taskReminders.taskId, taskIds))
  const result = new Map<string, Set<ReminderStage>>()
  for (const row of rows) {
    const key = stageKey(row.taskId, row.dueAt)
    const set = result.get(key) ?? new Set<ReminderStage>()
    set.add(row.stage as ReminderStage)
    result.set(key, set)
  }
  return result
}

/**
 * Отправка этапов одного поручения. Поручение перечитывается под блокировкой:
 * если его успели принять, отменить или продлить, этапы старого срока не шлются.
 */
async function fire(
  tx: Executor,
  row: DueRow,
  plan: StagePlan,
  afterWorkingDays: number,
): Promise<number> {
  const [current] = await tx
    .select({ status: tasks.status, dueAt: tasks.dueAt, assigneeId: tasks.assigneeId })
    .from(tasks)
    .where(eq(tasks.id, row.id))
    .for('update')
  if (!current || !WORKING_STATUSES.includes(current.status)) return 0
  if (!sameMoment(current.dueAt, row.dueAt)) return 0
  const ctx = systemCtx('tasks.deadlines')
  const mark = (stage: ReminderStage, skipped: boolean) =>
    tx
      .insert(taskReminders)
      .values({ taskId: row.id, stage, dueAt: row.dueAt, skipped })
      .onConflictDoNothing()
      .returning({ stage: taskReminders.stage })

  for (const stage of plan.skip) await mark(stage, true)
  const view = { id: row.id, spaceId: row.spaceId, title: row.title }
  let count = 0
  for (const stage of plan.fire) {
    // Эскалировать некому — этап отмечается пропущенным
    const managerId =
      stage === 'escalated' && current.assigneeId
        ? await directory().manager(current.assigneeId)
        : null
    if (stage === 'escalated' && !managerId) {
      await mark(stage, true)
      continue
    }
    const inserted = await mark(stage, false)
    if (inserted.length === 0) continue
    if (stage === 'overdue') {
      await emit(tx, ctx, view, 'task.overdue', { key: row.key, dueAt: row.dueAt })
    } else if (stage === 'escalated' && managerId) {
      await emit(tx, ctx, view, 'task.escalated', {
        key: row.key,
        dueAt: row.dueAt,
        managerId,
        afterWorkingDays,
      })
    } else {
      await emit(tx, ctx, view, 'task.due_soon', {
        key: row.key,
        stage,
        dueAt: row.dueAt,
        workingDaysLeft: Math.max(0, plan.workingDaysLeft),
      })
    }
    count += 1
  }
  return count
}
