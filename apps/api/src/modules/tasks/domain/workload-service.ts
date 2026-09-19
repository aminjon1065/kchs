import type {
  IssuedSummary,
  QueryResult,
  QuerySpec,
  TeamSummary,
  WorkloadPerson,
  WorkloadQuery,
  WorkloadReport,
} from '@kchs/contracts'
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { addDays, localDate, startOfLocalDay } from '~/kernel/business-calendar/working-days.js'
import { directory } from '~/kernel/directory/port.js'
import { DatasetQueries } from '~/modules/data/public.js'
import { OrgService } from '~/modules/identity/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, taskExtensions, tasks } from '~/shared/db/schema/index.js'
import { CLOSED, overdueSql, refsOf, selectTasks } from './task-core.js'
import { listItems } from './task-service.js'

/** Понедельник недели дня `day`. */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
  return addDays(day, -((dow + 6) % 7))
}

function records(result: QueryResult): Array<Record<string, unknown>> {
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
  )
}

const count = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

const OPEN_STATUS = { field: 'status', op: 'not_in', value: ['done', 'accepted', 'cancelled'] }

/** Подразделение с вложенными — по дереву оргструктуры. */
async function unitSubtree(unitId: string): Promise<string[]> {
  const tree = await OrgService.tree()
  const children = new Map<string, string[]>()
  for (const unit of tree) {
    if (unit.parentId)
      children.set(unit.parentId, [...(children.get(unit.parentId) ?? []), unit.id])
  }
  const result: string[] = []
  const stack = [unitId]
  while (stack.length > 0) {
    const next = stack.pop() as string
    result.push(next)
    stack.push(...(children.get(next) ?? []))
  }
  return result
}

/**
 * Нагрузка (10-tasks-projects.md §6, P3-E03 S03, ADR-0082): люди × недели —
 * открытые задачи и поручения со сроком на неделе, просрочки, без срока.
 * Считается запросами к системному датасету «Задачи» с правами смотрящего:
 * руководитель видит поручения подчинённых, обычные задачи — как всегда.
 */
export const WorkloadService = {
  async report(ctx: UserCtx, query: WorkloadQuery): Promise<WorkloadReport> {
    const me = ctx.onBehalfOf ?? ctx.userId
    let scope: WorkloadReport['scope']
    let userIds: string[]
    if (query.unitId) {
      scope = 'unit'
      userIds = await OrgService.members(await unitSubtree(query.unitId))
    } else {
      const team = await directory().subordinates(me)
      scope = team.length > 0 ? 'subordinates' : 'self'
      userIds = team.length > 0 ? team : [me]
    }
    const today = localDate(new Date(), ctx.timezone)
    const weeks: string[] = []
    for (let index = 0; index < query.weeks; index++)
      weeks.push(addDays(mondayOf(today), 7 * index))
    if (userIds.length === 0) return { scope, weeks, people: [] }

    const end = startOfLocalDay(addDays(weeks[weeks.length - 1] as string, 7), ctx.timezone)
    const start = startOfLocalDay(weeks[0] as string, ctx.timezone)
    const base = { field: 'assignee', op: 'in', value: userIds }
    const spec = (steps: unknown[]): QuerySpec =>
      ({ version: 1, source: { kind: 'system', name: 'tasks' }, steps }) as unknown as QuerySpec

    const [totals, cells, refs] = await Promise.all([
      DatasetQueries.run(
        ctx,
        spec([
          { type: 'filter', where: { and: [base, OPEN_STATUS] } },
          {
            type: 'aggregate',
            groupBy: [{ field: 'assignee' }],
            measures: [
              { alias: 'open', agg: 'count' },
              { alias: 'overdue', agg: 'count', filter: { field: 'overdue', op: 'is_true' } },
              { alias: 'no_due', agg: 'count', filter: { field: 'due_at', op: 'is_empty' } },
              {
                alias: 'later',
                agg: 'count',
                filter: { field: 'due_at', op: 'gte', value: end.toISOString() },
              },
            ],
          },
        ]),
        { maxRows: null },
      ),
      DatasetQueries.run(
        ctx,
        spec([
          {
            type: 'filter',
            where: {
              and: [
                base,
                OPEN_STATUS,
                { field: 'due_at', op: 'gte', value: start.toISOString() },
                { field: 'due_at', op: 'lt', value: end.toISOString() },
              ],
            },
          },
          {
            type: 'aggregate',
            groupBy: [{ field: 'assignee' }, { field: 'due_at', bucket: 'week', alias: 'week' }],
            measures: [
              { alias: 'total', agg: 'count' },
              {
                alias: 'instructions',
                agg: 'count',
                filter: { field: 'kind', op: 'eq', value: 'instruction' },
              },
            ],
          },
        ]),
        { maxRows: null },
      ),
      refsOf(userIds),
    ])

    const totalsBy = new Map(records(totals).map((row) => [String(row.assignee), row]))
    const cellsBy = new Map<string, Record<string, unknown>>()
    for (const row of records(cells)) {
      const week = localDate(new Date(String(row.week)), ctx.timezone)
      cellsBy.set(`${String(row.assignee)}|${week}`, row)
    }
    const people: WorkloadPerson[] = userIds.flatMap((userId) => {
      const user = refs.get(userId)
      if (!user) return []
      const total = totalsBy.get(userId) ?? {}
      return [
        {
          user,
          open: count(total.open),
          overdue: count(total.overdue),
          noDue: count(total.no_due),
          later: count(total.later),
          cells: weeks.map((week) => {
            const cell = cellsBy.get(`${userId}|${week}`) ?? {}
            return { week, total: count(cell.total), instructions: count(cell.instructions) }
          }),
        },
      ]
    })
    people.sort(
      (a, b) =>
        b.overdue - a.overdue ||
        b.open - a.open ||
        a.user.displayName.localeCompare(b.user.displayName, ctx.locale),
    )
    return { scope, weeks, people }
  },
}

/**
 * «Мой день» (12-calendar-notifications-home.md §4): «Выданные мной» — поручения
 * на контроле по статусам, «Команда» — просрочки и нагрузка отдела руководителя.
 */
export const HomeSummaries = {
  async issued(ctx: UserCtx): Promise<IssuedSummary> {
    const me = ctx.onBehalfOf ?? ctx.userId
    const zone = ctx.timezone
    const mine = and(
      eq(tasks.kind, 'instruction'),
      eq(tasks.authorId, me),
      isNull(tasks.parentId),
      sql`${objects.deletedAt} IS NULL`,
      notInArray(tasks.status, CLOSED),
    )
    const [row] = await db()
      .select({
        assigned: sql<number>`count(*) filter (where ${tasks.status} = 'assigned')::int`,
        inProgress: sql<number>`count(*) filter (where ${tasks.status} = 'in_progress')::int`,
        returned: sql<number>`count(*) filter (where ${tasks.status} = 'returned')::int`,
        reported: sql<number>`count(*) filter (where ${tasks.status} = 'reported')::int`,
        overdue: sql<number>`count(*) filter (where ${overdueSql()})::int`,
        dueToday: sql<number>`count(*) filter (where
          (${tasks.dueAt} at time zone ${zone})::date = (now() at time zone ${zone})::date)::int`,
      })
      .from(tasks)
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(mine)
    // Запросы продления — соединением: коррелированный подзапрос в полях select
    // Drizzle выводит без имён таблиц
    const [requests] = await db()
      .select({ count: sql<number>`count(distinct ${taskExtensions.taskId})::int` })
      .from(taskExtensions)
      .innerJoin(tasks, eq(tasks.id, taskExtensions.taskId))
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(and(mine, eq(taskExtensions.status, 'pending')))
    // Требуют внимания: отчёты, запросы продления, просрочки — по срочности
    const attention = await selectTasks(db())
      .where(
        and(
          mine,
          sql`(${tasks.status} = 'reported' OR ${overdueSql()} OR EXISTS (
            SELECT 1 FROM ${taskExtensions} te
             WHERE te.task_id = ${tasks.id} AND te.status = 'pending'))`,
        ),
      )
      .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`)
      .limit(8)
    return {
      assigned: row?.assigned ?? 0,
      inProgress: row?.inProgress ?? 0,
      returned: row?.returned ?? 0,
      reported: row?.reported ?? 0,
      overdue: row?.overdue ?? 0,
      dueToday: row?.dueToday ?? 0,
      extensionRequests: requests?.count ?? 0,
      items: await listItems(ctx, attention),
    }
  },

  async team(ctx: UserCtx): Promise<TeamSummary> {
    const me = ctx.onBehalfOf ?? ctx.userId
    const team = await directory().subordinates(me)
    if (team.length === 0) return { manager: false, members: [], overdue: [] }
    const zone = ctx.timezone
    const visible = and(
      sql`${objects.deletedAt} IS NULL`,
      visibleObjectsSql(ctx, 'task'),
      inArray(tasks.assigneeId, team),
      notInArray(tasks.status, CLOSED),
    )
    const [rows, overdueRows, refs] = await Promise.all([
      db()
        .select({
          assigneeId: tasks.assigneeId,
          open: sql<number>`count(*)::int`,
          overdue: sql<number>`count(*) filter (where ${overdueSql()})::int`,
          dueThisWeek: sql<number>`count(*) filter (where
            date_trunc('week', ${tasks.dueAt} at time zone ${zone})
              = date_trunc('week', now() at time zone ${zone}))::int`,
        })
        .from(tasks)
        .innerJoin(objects, eq(objects.id, tasks.id))
        .where(visible)
        .groupBy(tasks.assigneeId),
      selectTasks(db()).where(and(visible, overdueSql())).orderBy(asc(tasks.dueAt)).limit(10),
      refsOf(team),
    ])
    const members = rows.flatMap((row) => {
      const user = row.assigneeId ? refs.get(row.assigneeId) : undefined
      return user
        ? [{ user, open: row.open, overdue: row.overdue, dueThisWeek: row.dueThisWeek }]
        : []
    })
    members.sort((a, b) => b.overdue - a.overdue || b.open - a.open)
    return { manager: true, members, overdue: await listItems(ctx, overdueRows) }
  },
}
