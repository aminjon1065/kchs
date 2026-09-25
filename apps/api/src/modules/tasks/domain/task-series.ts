import {
  atLeast,
  type TaskSeriesCreateInput,
  type TaskSeriesPatch,
  type TaskSeriesRecord,
  type TaskSeriesRule,
  type TaskSeriesStatus,
} from '@kchs/contracts'
import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { localDate } from '~/kernel/business-calendar/working-days.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { config } from '~/shared/config/index.js'
import { actorId, type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  objects,
  type TaskSeriesRuleValue,
  type TaskSeriesTemplateValue,
  taskSeries,
  tasks,
} from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { assertPeople, projectInfo, refsOf } from './task-core.js'
import { nextOccurrence } from './task-recurrence.js'
import { TaskService } from './task-service.js'

/** Сколько серий обрабатывает один проход задания. */
const BATCH = 50

const COLUMNS = {
  id: taskSeries.id,
  kind: taskSeries.kind,
  template: taskSeries.template,
  rule: taskSeries.rule,
  dueWorkingDays: taskSeries.dueWorkingDays,
  startsOn: taskSeries.startsOn,
  endsOn: taskSeries.endsOn,
  maxCount: taskSeries.maxCount,
  status: taskSeries.status,
  statusReason: taskSeries.statusReason,
  createdCount: taskSeries.createdCount,
  lastOccurrence: taskSeries.lastOccurrence,
  nextRunAt: taskSeries.nextRunAt,
  authorId: taskSeries.authorId,
  title: objects.title,
  spaceId: objects.spaceId,
}

type SeriesRow = Awaited<ReturnType<typeof selectSeries>>[number]

function selectSeries(executor: Executor) {
  return executor.select(COLUMNS).from(taskSeries).innerJoin(objects, eq(objects.id, taskSeries.id))
}

async function loadSeries(executor: Executor, id: string, lock = false): Promise<SeriesRow | null> {
  const query = selectSeries(executor)
    .where(and(eq(taskSeries.id, id), sql`${objects.deletedAt} IS NULL`))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: taskSeries }) : await query
  return row ?? null
}

/** Следующий экземпляр после `after`; с исчерпанным лимитом — нет. */
function nextRun(row: Pick<SeriesRow, 'rule' | 'startsOn' | 'endsOn'>, after: Date): Date | null {
  return (
    nextOccurrence(
      row.rule as TaskSeriesRule,
      { startsOn: row.startsOn, endsOn: row.endsOn },
      after,
      config().TZ,
    )?.at ?? null
  )
}

async function recordsOf(ctx: UserCtx, rows: SeriesRow[]): Promise<TaskSeriesRecord[]> {
  const people = await refsOf(
    rows.flatMap((row) => [
      row.authorId,
      row.template.assigneeId ?? null,
      row.template.controllerId ?? null,
    ]),
  )
  const projectIds = [
    ...new Set(rows.map((row) => row.template.projectId).filter((id): id is string => Boolean(id))),
  ]
  const projects = await projectInfo(db(), projectIds)
  const records: TaskSeriesRecord[] = []
  for (const row of rows) {
    const decision = await authorize(ctx, 'view', row.id, { soft: true })
    if (!decision.allowed) continue
    const project = row.template.projectId ? projects.get(row.template.projectId) : null
    records.push({
      id: row.id,
      kind: row.kind as 'task' | 'instruction',
      title: row.title,
      description: row.template.description ?? null,
      spaceId: row.spaceId,
      project: project ? { id: project.id, key: project.key, name: project.name } : null,
      author: row.authorId ? (people.get(row.authorId) ?? null) : null,
      assignee: row.template.assigneeId ? (people.get(row.template.assigneeId) ?? null) : null,
      controller: row.template.controllerId
        ? (people.get(row.template.controllerId) ?? null)
        : null,
      priority: row.template.priority,
      rule: row.rule as TaskSeriesRule,
      dueWorkingDays: row.dueWorkingDays,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      maxCount: row.maxCount,
      status: row.status as TaskSeriesStatus,
      statusReason: row.statusReason,
      createdCount: row.createdCount,
      lastOccurrence: row.lastOccurrence,
      nextRunAt: row.nextRunAt,
      can: { edit: atLeast(decision.level, 'edit') && row.status !== 'stopped' },
    })
  }
  return records
}

/**
 * Повторяющиеся поручения и задачи (ADR-0156). Серия — объект реестра `task_series`
 * с шаблоном экземпляра и правилом; права — как у объекта, ведёт серию её автор.
 * Экземпляры создаёт задание от имени автора: права на создание проверяются заново,
 * и серия, чей автор их потерял, встаёт на паузу с причиной.
 */
export const TaskSeriesService = {
  async create(tx: Executor, ctx: UserCtx, input: TaskSeriesCreateInput): Promise<string> {
    const authorId = actorId(ctx)
    if (!authorId) throw errors.validation('У серии должен быть автор')
    const template = input.template
    const project = template.projectId
      ? ((await projectInfo(tx, [template.projectId])).get(template.projectId) ?? null)
      : null
    if (template.projectId) {
      if (!project) throw errors.notFound('Проект')
      await authorize(ctx, 'create_task', template.projectId)
    }
    let spaceId = project?.spaceId ?? null
    if (!spaceId && template.spaceId) {
      await authorize(ctx, 'create_child', template.spaceId)
      spaceId = template.spaceId
    }
    if (!spaceId) spaceId = await SpaceService.ensurePersonal(tx, ctx, authorId, '')
    await assertPeople(
      [
        authorId,
        template.assigneeId ?? null,
        template.controllerId ?? null,
        ...template.coAssigneeIds,
      ].filter((id): id is string => Boolean(id)),
    )

    const value: TaskSeriesTemplateValue = {
      kind: template.kind,
      title: template.title,
      description: template.description?.trim() || null,
      projectId: project?.id ?? null,
      spaceId,
      assigneeId: template.assigneeId ?? null,
      coAssigneeIds: [...new Set(template.coAssigneeIds)],
      controllerId: template.controllerId ?? null,
      priority: template.priority,
      labels: [...new Set(template.labels)],
    }
    const object = await ObjectService.create(tx, ctx, {
      type: 'task_series',
      spaceId,
      parentId: project?.id ?? null,
      title: template.title,
      ownerId: authorId,
      accessMode: template.kind === 'instruction' && !project ? 'restricted' : 'inherit',
      meta: { kind: template.kind, freq: input.rule.freq, status: 'active' },
    })
    const window = { startsOn: input.startsOn, endsOn: input.endsOn ?? null }
    await tx.insert(taskSeries).values({
      id: object.id,
      kind: template.kind,
      template: value,
      rule: input.rule as TaskSeriesRuleValue,
      dueWorkingDays: input.dueWorkingDays,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      maxCount: input.maxCount ?? null,
      status: 'active',
      nextRunAt: nextRun({ rule: input.rule, ...window }, new Date())?.toISOString() ?? null,
      authorId,
    })
    return object.id
  },

  async get(ctx: UserCtx, id: string): Promise<TaskSeriesRecord> {
    await authorize(ctx, 'view', id)
    const row = await loadSeries(db(), id)
    if (!row) throw errors.notFound('Серия')
    const [record] = await recordsOf(ctx, [row])
    if (!record) throw errors.notFound('Серия')
    return record
  },

  /** Серии, видимые пользователю: свежие сверху. */
  async list(ctx: UserCtx): Promise<TaskSeriesRecord[]> {
    const rows = await selectSeries(db())
      .where(and(sql`${objects.deletedAt} IS NULL`, visibleObjectsSql(ctx, 'task_series')))
      .orderBy(desc(objects.createdAt))
      .limit(200)
    return recordsOf(ctx, rows)
  },

  /** Правка шаблона и правила — для будущих экземпляров; созданные остаются как есть. */
  async update(tx: Executor, ctx: Ctx, id: string, patch: TaskSeriesPatch): Promise<void> {
    await authorize(ctx, 'edit', id)
    const row = await loadSeries(tx, id, true)
    if (!row) throw errors.notFound('Серия')
    if (row.status === 'stopped') throw errors.conflict('Серия остановлена — изменить её нельзя')
    if (row.kind === 'instruction' && patch.assigneeId === null) {
      throw errors.validation('У поручения должен быть исполнитель')
    }
    const people = [patch.assigneeId, patch.controllerId].filter((value): value is string =>
      Boolean(value),
    )
    if (people.length > 0) await assertPeople(people)
    const template: TaskSeriesTemplateValue = {
      ...row.template,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description?.trim() || null }
        : {}),
      ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
      ...(patch.controllerId !== undefined ? { controllerId: patch.controllerId } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    }
    const rule = (patch.rule ?? row.rule) as TaskSeriesRule
    const endsOn = patch.endsOn === undefined ? row.endsOn : patch.endsOn
    await tx
      .update(taskSeries)
      .set({
        template,
        rule: rule as TaskSeriesRuleValue,
        ...(patch.dueWorkingDays !== undefined ? { dueWorkingDays: patch.dueWorkingDays } : {}),
        endsOn,
        ...(patch.maxCount !== undefined ? { maxCount: patch.maxCount } : {}),
        nextRunAt:
          row.status === 'active'
            ? (nextRun({ rule, startsOn: row.startsOn, endsOn }, new Date())?.toISOString() ?? null)
            : row.nextRunAt,
      })
      .where(eq(taskSeries.id, id))
    // Событие реестра: активность и realtime видят правку серии
    await ObjectService.update(tx, ctx, id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      meta: { freq: rule.freq },
      mergeMeta: true,
    })
  },

  /** Пауза, возобновление, остановка. Остановленную серию не возобновить. */
  async setStatus(tx: Executor, ctx: Ctx, id: string, status: TaskSeriesStatus): Promise<void> {
    await authorize(ctx, 'edit', id)
    const row = await loadSeries(tx, id, true)
    if (!row) throw errors.notFound('Серия')
    if (row.status === 'stopped') throw errors.conflict('Серия остановлена')
    if (row.status === status) return
    await tx
      .update(taskSeries)
      .set({
        status,
        statusReason: null,
        nextRunAt: status === 'active' ? (nextRun(row, new Date())?.toISOString() ?? null) : null,
      })
      .where(eq(taskSeries.id, id))
    await ObjectService.update(tx, ctx, id, { meta: { status }, mergeMeta: true })
  },

  /**
   * Проход задания: у каждой серии, чей срок наступил, — один экземпляр на дату правила.
   * Пропущенные даты (задание стояло) не догоняются: лента поручений не заливается
   * задним числом, следующий экземпляр — по правилу от текущего момента.
   */
  async run(now = new Date()): Promise<{ created: number; paused: number }> {
    const due = await db()
      .select({ id: taskSeries.id })
      .from(taskSeries)
      .where(and(eq(taskSeries.status, 'active'), lte(taskSeries.nextRunAt, now.toISOString())))
      .limit(BATCH)
    let created = 0
    let paused = 0
    for (const { id } of due) {
      const outcome = await db().transaction((tx) => runOne(tx, id, now))
      if (outcome === 'created') created += 1
      if (outcome === 'paused') paused += 1
    }
    return { created, paused }
  },
}

async function pause(tx: Executor, id: string, reason: string): Promise<'paused'> {
  await tx
    .update(taskSeries)
    .set({ status: 'paused', statusReason: reason.slice(0, 500), nextRunAt: null })
    .where(eq(taskSeries.id, id))
  // Событие реестра: автор увидит паузу в активности серии
  await ObjectService.update(tx, systemCtx('tasks.series'), id, {
    meta: { status: 'paused' },
    mergeMeta: true,
  })
  return 'paused'
}

async function runOne(
  tx: Executor,
  id: string,
  now: Date,
): Promise<'created' | 'skipped' | 'paused' | 'stopped'> {
  const [row] = await selectSeries(tx)
    .where(and(eq(taskSeries.id, id), sql`${objects.deletedAt} IS NULL`))
    .limit(1)
    .for('update', { of: taskSeries, skipLocked: true })
  if (row?.status !== 'active' || !row.nextRunAt) return 'skipped'
  if (new Date(row.nextRunAt).getTime() > now.getTime()) return 'skipped'
  if (row.maxCount !== null && row.createdCount >= row.maxCount) {
    await tx
      .update(taskSeries)
      .set({ status: 'stopped', nextRunAt: null })
      .where(eq(taskSeries.id, id))
    return 'stopped'
  }
  const occurrence = localDate(new Date(row.nextRunAt), config().TZ)
  const ctx = row.authorId ? await buildUserCtxFor(row.authorId) : null
  if (!ctx) return pause(tx, id, 'Автор серии больше не работает в системе')

  const [existing] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.seriesId, id), eq(tasks.occurrence, occurrence)))
    .limit(1)
  let outcome: 'created' | 'skipped' = 'skipped'
  if (!existing) {
    const template = row.template
    try {
      await TaskService.create(
        tx,
        ctx,
        {
          kind: template.kind,
          title: template.title,
          ...(template.description ? { description: template.description } : {}),
          ...(template.projectId ? { projectId: template.projectId } : {}),
          ...(!template.projectId && row.spaceId ? { spaceId: row.spaceId } : {}),
          ...(template.assigneeId ? { assigneeId: template.assigneeId } : {}),
          coAssigneeIds: template.coAssigneeIds,
          ...(template.controllerId ? { controllerId: template.controllerId } : {}),
          dueWorkingDays: row.dueWorkingDays,
          priority: template.priority as 1 | 2 | 3 | 4,
          labels: template.labels,
        },
        { series: { id, occurrence } },
      )
      outcome = 'created'
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        logger().warn({ seriesId: id, err: error.message }, 'серия поручений встала на паузу')
        return pause(tx, id, error.message)
      }
      throw error
    }
  }
  const createdCount = row.createdCount + (outcome === 'created' ? 1 : 0)
  const exhausted = row.maxCount !== null && createdCount >= row.maxCount
  const next = exhausted ? null : nextRun(row, now)
  await tx
    .update(taskSeries)
    .set({
      createdCount,
      lastOccurrence: occurrence,
      nextRunAt: next?.toISOString() ?? null,
      status: next ? 'active' : 'stopped',
    })
    .where(eq(taskSeries.id, id))
  return outcome
}
