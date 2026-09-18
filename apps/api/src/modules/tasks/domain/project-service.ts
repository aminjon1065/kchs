import {
  CLOSED_TASK_STATUSES,
  DEFAULT_TASK_WORKFLOW,
  type ProjectCreateInput,
  type ProjectListQuery,
  type ProjectRecord,
  type ProjectStatus,
  type ProjectUpdateInput,
  TaskStatus,
  type UserRef,
} from '@kchs/contracts'
import { and, asc, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { objects, projects, tasks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

const CLOSED = [...CLOSED_TASK_STATUSES] as string[]

function selectProjects(executor: Executor) {
  return executor
    .select({
      id: projects.id,
      key: projects.key,
      name: objects.title,
      description: projects.description,
      status: projects.status,
      leadId: projects.leadId,
      spaceId: objects.spaceId,
      startsAt: projects.startsAt,
      endsAt: projects.endsAt,
      workflow: projects.workflow,
      createdAt: objects.createdAt,
    })
    .from(projects)
    .innerJoin(objects, eq(objects.id, projects.id))
}

type ProjectRow = Awaited<ReturnType<typeof selectProjects>>[number]

/** Открытые, просроченные и закрытые задачи проектов одним запросом. */
async function countsOf(ids: string[]): Promise<Map<string, ProjectRecord['counts']>> {
  if (ids.length === 0) return new Map()
  const rows = await db()
    .select({
      projectId: tasks.projectId,
      open: sql<number>`count(*) filter (where ${notInArray(tasks.status, CLOSED)})::int`,
      overdue: sql<number>`count(*) filter (where ${notInArray(tasks.status, CLOSED)}
        and ${tasks.dueAt} < now())::int`,
      closed: sql<number>`count(*) filter (where ${inArray(tasks.status, CLOSED)})::int`,
    })
    .from(tasks)
    .innerJoin(objects, eq(objects.id, tasks.id))
    .where(and(inArray(tasks.projectId, ids), sql`${objects.deletedAt} IS NULL`))
    .groupBy(tasks.projectId)
  return new Map(
    rows.map((row) => [
      row.projectId as string,
      { open: row.open, overdue: row.overdue, closed: row.closed },
    ]),
  )
}

function workflowOf(value: { statuses?: unknown }): TaskStatus[] {
  const statuses = Array.isArray(value.statuses)
    ? value.statuses.flatMap((status) => {
        const parsed = TaskStatus.safeParse(status)
        return parsed.success ? [parsed.data] : []
      })
    : []
  return statuses.length >= 2 ? statuses : [...DEFAULT_TASK_WORKFLOW]
}

function recordOf(
  row: ProjectRow,
  people: Map<string, UserRef>,
  counts: Map<string, ProjectRecord['counts']>,
): ProjectRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    lead: row.leadId ? (people.get(row.leadId) ?? null) : null,
    spaceId: row.spaceId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    workflow: { statuses: workflowOf(row.workflow) },
    counts: counts.get(row.id) ?? { open: 0, overdue: 0, closed: 0 },
    createdAt: row.createdAt,
  }
}

async function recordsOf(rows: ProjectRow[]): Promise<ProjectRecord[]> {
  const leadIds = [
    ...new Set(rows.map((row) => row.leadId).filter((id): id is string => Boolean(id))),
  ]
  const [people, counts] = await Promise.all([
    directory().refs(leadIds),
    countsOf(rows.map((row) => row.id)),
  ])
  return rows.map((row) => recordOf(row, people, counts))
}

/**
 * Проекты (10-tasks-projects.md §2): ключ задач, руководитель, пространство
 * участников и рабочий процесс. Задачи проекта — его дочерние объекты,
 * доступ к ним наследуется от проекта.
 */
export const ProjectService = {
  async create(tx: Executor, ctx: Ctx, input: ProjectCreateInput): Promise<string> {
    await authorize(ctx, 'create_child', input.spaceId)
    const leadId = input.leadId ?? actorId(ctx)
    if (input.leadId) {
      const refs = await directory().refs([input.leadId])
      if (!refs.has(input.leadId)) throw errors.validation('Руководитель проекта не найден')
    }
    const [taken] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.key, input.key))
      .limit(1)
    if (taken) throw errors.conflict(`Проект с ключом «${input.key}» уже есть`)

    const object = await ObjectService.create(tx, ctx, {
      type: 'project',
      spaceId: input.spaceId,
      title: input.name,
      subtitle: input.key,
      meta: { key: input.key, status: 'active' },
    })
    try {
      await tx.insert(projects).values({
        id: object.id,
        key: input.key,
        leadId,
        status: 'active',
        description: input.description?.trim() || null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        workflow: { statuses: [...DEFAULT_TASK_WORKFLOW] },
      })
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw errors.conflict(`Проект с ключом «${input.key}» уже есть`)
      }
      throw error
    }
    await publishEvent(tx, ctx, {
      type: 'project.created',
      object: { id: object.id, type: 'project', spaceId: input.spaceId, title: input.name },
      payload: { key: input.key, name: input.name },
    })
    return object.id
  },

  async get(ctx: UserCtx, id: string): Promise<ProjectRecord> {
    await authorize(ctx, 'view', id)
    const [row] = await selectProjects(db())
      .where(and(eq(projects.id, id), sql`${objects.deletedAt} IS NULL`))
      .limit(1)
    if (!row) throw errors.notFound('Проект')
    const [record] = await recordsOf([row])
    return record as ProjectRecord
  },

  async list(ctx: UserCtx, query: ProjectListQuery): Promise<ProjectRecord[]> {
    const conditions: SQL[] = [sql`${objects.deletedAt} IS NULL`, visibleObjectsSql(ctx, 'project')]
    if (query.spaceId) conditions.push(eq(objects.spaceId, query.spaceId))
    if (query.status) conditions.push(eq(projects.status, query.status))
    const rows = await selectProjects(db())
      .where(and(...conditions))
      .orderBy(asc(objects.title))
      .limit(200)
    return recordsOf(rows)
  },

  async update(tx: Executor, ctx: Ctx, id: string, patch: ProjectUpdateInput): Promise<void> {
    await authorize(ctx, 'manage', id)
    if (patch.leadId) {
      const refs = await directory().refs([patch.leadId])
      if (!refs.has(patch.leadId)) throw errors.validation('Руководитель проекта не найден')
    }
    const values = {
      ...(patch.description !== undefined
        ? { description: patch.description?.trim() || null }
        : {}),
      ...(patch.leadId !== undefined ? { leadId: patch.leadId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
    }
    if (Object.keys(values).length > 0) {
      await tx.update(projects).set(values).where(eq(projects.id, id))
    }
    // Изменение проекта — событие реестра: активность, поиск, открытые вкладки
    await ObjectService.update(tx, ctx, id, {
      ...(patch.name !== undefined ? { title: patch.name } : {}),
      meta: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.leadId !== undefined ? { leadId: patch.leadId } : {}),
      },
      mergeMeta: true,
    })
  },
}
