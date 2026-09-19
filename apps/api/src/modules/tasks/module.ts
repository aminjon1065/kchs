import { PassThrough } from 'node:stream'
import {
  ControlExportQuery,
  ControlList,
  ControlListQuery,
  ControlQuery,
  ControlReport,
  IssuedSummary,
  ProjectCreateInput,
  ProjectListQuery,
  ProjectRecord,
  ProjectUpdateInput,
  TaskCancelInput,
  TaskCreateInput,
  TaskExtensionDecisionInput,
  TaskExtensionRequestInput,
  TaskList,
  TaskListQuery,
  TaskReassignInput,
  TaskRecord,
  TaskReportInput,
  TaskReturnInput,
  TaskSettings,
  TaskStatusInput,
  TaskSummary,
  TaskUpdateInput,
  TeamSummary,
  WorkloadQuery,
  WorkloadReport,
} from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerInboxActionHandler } from '~/kernel/inbox/actions.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { queue } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { registerSystemDataset } from '~/kernel/system-datasets.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, projects, tasks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { controlExport } from './domain/control-export.js'
import { ControlService } from './domain/control-service.js'
import { INSTRUCTIONS_SYSTEM_DATASET } from './domain/instructions-dataset.js'
import { ProjectService } from './domain/project-service.js'
import { TASKS_SYSTEM_DATASET } from './domain/system-dataset.js'
import { dueFromDate } from './domain/task-due.js'
import { taskPolicy } from './domain/task-policy.js'
import { TaskReminders } from './domain/task-reminders.js'
import { TaskService } from './domain/task-service.js'
import { TaskSettingsService } from './domain/task-settings.js'
import { taskSubscribers } from './domain/task-subscribers.js'
import { HomeSummaries, WorkloadService } from './domain/workload-service.js'

const IdParam = z.object({ id: z.uuid() })
const RowSourceQuery = z.object({
  datasetId: z.uuid(),
  rowId: z.string().regex(/^\d{1,18}$/),
})
const SourceQuery = z.object({ objectId: z.uuid() })
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Запрос продления из Входящих или Telegram: дата в `payload.dueDate`, обоснование — комментарий. */
async function extendFromInbox(
  ctx: UserCtx,
  taskId: string,
  comment: string | undefined,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (!comment) throw errors.validation('Укажите обоснование продления')
  const dueAt = dueFromDate(payload?.dueDate, ctx.timezone)
  await db().transaction((tx) =>
    TaskService.requestExtension(tx, ctx, taskId, { dueAt, reason: comment }),
  )
}

/**
 * Типы `task` и `project`, системный датасет «Задачи» и действия поручений
 * во Входящих — при старте в любой роли: HTTP исполняет кнопки Входящих,
 * воркер — подписчиков.
 */
export function registerTasksObjectTypes(): void {
  registerObjectType({
    type: 'project',
    labelKey: 'objects.types.project',
    icon: 'project',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      /** Создать задачу в проекте. */
      create_task: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          key: projects.key,
          description: projects.description,
        })
        .from(projects)
        .innerJoin(objects, eq(objects.id, projects.id))
        .where(eq(projects.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'project',
        spaceId: row.spaceId,
        title: row.title,
        body: [row.key, row.description ?? ''].join('\n').slice(0, 20_000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
  })

  registerObjectType({
    type: 'task',
    labelKey: 'objects.types.task',
    icon: 'task',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    // Руководитель видит поручения подчинённых; заместитель действует за участника
    policy: taskPolicy,
    listFields: [
      {
        key: 'status',
        labelKey: 'tasks.fields.status',
        type: 'select',
        sql: sql`${objects.meta}->>'status'`,
        sortable: true,
      },
      {
        key: 'dueAt',
        labelKey: 'tasks.fields.due',
        type: 'datetime',
        sql: sql`(${objects.meta}->>'dueAt')::timestamptz`,
        sortable: true,
      },
    ],
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          key: tasks.key,
          description: tasks.description,
        })
        .from(tasks)
        .innerJoin(objects, eq(objects.id, tasks.id))
        .where(eq(tasks.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'task',
        spaceId: row.spaceId,
        title: row.title,
        body: [row.key, row.description ?? ''].join('\n').slice(0, 20_000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
  })

  registerSystemDataset(TASKS_SYSTEM_DATASET)
  registerSystemDataset(INSTRUCTIONS_SYSTEM_DATASET)

  // Кнопки поручения во Входящих (и в Telegram) исполняет модуль задач
  registerInboxActionHandler(
    'accept_instruction',
    async (ctx, { item, action, comment, payload }) => {
      if (!item.objectId) throw errors.validation('Нет такого действия')
      const taskId = item.objectId
      if (action === 'accept') {
        await db().transaction((tx) => TaskService.start(tx, ctx, taskId))
        return
      }
      if (action === 'extend') return extendFromInbox(ctx, taskId, comment, payload)
      throw errors.validation('Нет такого действия')
    },
  )
  registerInboxActionHandler(
    'report_instruction',
    async (ctx, { item, action, comment, payload }) => {
      if (!item.objectId) throw errors.validation('Нет такого действия')
      const taskId = item.objectId
      if (action === 'extend') return extendFromInbox(ctx, taskId, comment, payload)
      if (action !== 'report' || !comment) throw errors.validation('Отчёт — текстом об исполнении')
      await db().transaction((tx) =>
        TaskService.report(tx, ctx, taskId, { text: comment, objectIds: [] }),
      )
    },
  )
  registerInboxActionHandler('extend_due', async (ctx, { item, action, comment }) => {
    if (!item.objectId) throw errors.validation('Нет такого действия')
    const taskId = item.objectId
    if (action === 'approve') {
      await db().transaction((tx) =>
        TaskService.decideExtension(tx, ctx, taskId, {
          decision: 'approve',
          ...(comment ? { comment } : {}),
        }),
      )
      return
    }
    if (action === 'reject' && comment) {
      await db().transaction((tx) =>
        TaskService.decideExtension(tx, ctx, taskId, { decision: 'reject', comment }),
      )
      return
    }
    throw errors.validation('Нет такого действия')
  })
  registerInboxActionHandler('accept_result', async (ctx, { item, action, comment }) => {
    if (!item.objectId) throw errors.validation('Нет такого действия')
    const taskId = item.objectId
    if (action === 'accept') {
      await db().transaction((tx) => TaskService.accept(tx, ctx, taskId))
      return
    }
    if (action === 'return' && comment) {
      await db().transaction((tx) => TaskService.return(tx, ctx, taskId, { comment }))
      return
    }
    throw errors.validation('Нет такого действия')
  })
}

/** Подписчики и задания модуля — только в роли worker. */
export function registerTasksBackground(): void {
  for (const subscriber of taskSubscribers) registerSubscriber(subscriber)
  // Напоминания о сроках, просрочки и эскалации (ADR-0082)
  registerJobHandler({
    queue: 'maintenance',
    name: 'tasks.deadlines',
    concurrency: 1,
    handle: async () => TaskReminders.run(),
  })
}

/** Расписание: проход по срокам каждые 15 минут — идемпотентен по ключу задания. */
export async function scheduleTasksJobs(): Promise<void> {
  await queue('maintenance').add(
    'tasks.deadlines',
    {},
    { repeat: { pattern: '*/15 * * * *' }, jobId: 'cron:tasks.deadlines' },
  )
}

export function registerTasksRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/tasks',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Задачи и поручения: мои, поручил я, на контроле, все доступные',
    schema: { querystring: TaskListQuery, response: { 200: TaskList } },
    handler: async (request) => TaskService.list(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/tasks/summary',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Сводка «Мои задачи»: открытые, просроченные, на сегодня, ждут приёмки',
    schema: { response: { 200: TaskSummary } },
    handler: async (request) => TaskService.summary(request.ctx),
  })

  route({
    method: 'GET',
    url: '/tasks/control',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Контроль исполнения: матрица «подразделения × состояния», итоги, динамика',
    schema: { querystring: ControlQuery, response: { 200: ControlReport } },
    handler: async (request) => ControlService.report(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/tasks/control/list',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Контроль исполнения: поручения ячейки матрицы (просроченные — по умолчанию)',
    schema: { querystring: ControlListQuery, response: { 200: ControlList } },
    handler: async (request) => ControlService.list(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/tasks/control/export',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Контроль исполнения: выгрузка матрицы или списка в CSV или XLSX',
    schema: {
      querystring: ControlExportQuery.extend({
        view: z.enum(['matrix', 'list']).default('matrix'),
        bucket: ControlListQuery.shape.bucket,
      }),
    },
    handler: async (request, reply) => {
      const { format, view, bucket, ...query } = request.query
      const out = new PassThrough()
      const stamp = new Date().toISOString().slice(0, 10)
      reply
        .header('content-type', format === 'xlsx' ? XLSX_MIME : 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="kchs-control-${view}-${stamp}.${format}"`,
        )
      void controlExport(request.ctx, { ...query, view, bucket, format }, out).then(
        () => out.end(),
        (error: unknown) => out.destroy(error as Error),
      )
      return reply.send(out)
    },
  })

  route({
    method: 'GET',
    url: '/tasks/workload',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Нагрузка: люди × недели — открытые задачи и поручения, просрочки',
    schema: { querystring: WorkloadQuery, response: { 200: WorkloadReport } },
    handler: async (request) => WorkloadService.report(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/tasks/issued',
    auth: 'session',
    tags: ['tasks'],
    summary: '«Выданные мной»: поручения на контроле по статусам и требующие внимания',
    schema: { response: { 200: IssuedSummary } },
    handler: async (request) => HomeSummaries.issued(request.ctx),
  })

  route({
    method: 'GET',
    url: '/tasks/team',
    auth: 'session',
    tags: ['tasks'],
    summary: '«Команда»: просрочки и нагрузка подчинённых руководителя',
    schema: { response: { 200: TeamSummary } },
    handler: async (request) => HomeSummaries.team(request.ctx),
  })

  route({
    method: 'GET',
    url: '/tasks/settings',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Настройки поручений установки: эскалация просрочки',
    schema: { response: { 200: TaskSettings } },
    handler: async () => TaskSettingsService.current(),
  })

  route({
    method: 'PUT',
    url: '/admin/tasks/settings',
    auth: { capability: 'admin.system' },
    tags: ['tasks'],
    summary: 'Изменить настройки поручений: эскалация просрочки руководителю исполнителя',
    schema: { body: TaskSettings, response: { 200: TaskSettings } },
    handler: async (request) =>
      db().transaction((tx) => TaskSettingsService.update(tx, request.ctx, request.body)),
  })

  route({
    method: 'GET',
    url: '/tasks/by-source',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Поручения по источнику — документу или объекту (резолюции и поручения)',
    schema: { querystring: SourceQuery, response: { 200: TaskList } },
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.query.objectId)
      const items = await TaskService.bySource(request.ctx, request.query.objectId)
      return { items, total: items.length }
    },
  })

  route({
    method: 'GET',
    url: '/tasks/by-row',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Задачи и поручения по строке датасета',
    schema: { querystring: RowSourceQuery, response: { 200: TaskList } },
    handler: async (request) =>
      TaskService.forRow(request.ctx, request.query.datasetId, request.query.rowId),
  })

  route({
    method: 'POST',
    url: '/tasks',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Создать задачу или поручение',
    schema: { body: TaskCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      const id = await db().transaction((tx) => TaskService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/tasks/:id',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Карточка задачи: участники, сроки, отчёт, доступные действия',
    schema: { params: IdParam, response: { 200: TaskRecord } },
    handler: async (request) => TaskService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/tasks/:id',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Изменить задачу: название, описание, срок, исполнителей, приоритет',
    schema: { params: IdParam, body: TaskUpdateInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.update(tx, request.ctx, request.params.id, request.body),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/status',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Статус задачи по рабочему процессу (доска)',
    schema: { params: IdParam, body: TaskStatusInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.setStatus(tx, request.ctx, request.params.id, request.body.status),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/start',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Принять поручение к исполнению',
    schema: { params: IdParam, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) => TaskService.start(tx, request.ctx, request.params.id))
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/report',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Отчитаться об исполнении поручения',
    schema: { params: IdParam, body: TaskReportInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.report(tx, request.ctx, request.params.id, request.body),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/accept',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Принять отчёт и закрыть поручение',
    schema: { params: IdParam, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) => TaskService.accept(tx, request.ctx, request.params.id))
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/return',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Вернуть поручение на доработку',
    schema: { params: IdParam, body: TaskReturnInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.return(tx, request.ctx, request.params.id, request.body),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/reassign',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Переназначить исполнителя поручения (автор или контролёр)',
    schema: { params: IdParam, body: TaskReassignInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.reassign(tx, request.ctx, request.params.id, request.body),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/extension',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Запросить продление срока: желаемый срок и обоснование — решение за автором',
    schema: { params: IdParam, body: TaskExtensionRequestInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.requestExtension(tx, request.ctx, request.params.id, request.body),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/extension/decide',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Согласовать продление (запрошенный или другой срок) или отказать',
    schema: { params: IdParam, body: TaskExtensionDecisionInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.decideExtension(tx, request.ctx, request.params.id, request.body),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/tasks/:id/cancel',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Отменить задачу или поручение',
    schema: { params: IdParam, body: TaskCancelInput, response: { 200: TaskRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        TaskService.cancel(tx, request.ctx, request.params.id, request.body),
      )
      return TaskService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/projects',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Проекты, доступные пользователю',
    schema: {
      querystring: ProjectListQuery,
      response: { 200: z.object({ items: z.array(ProjectRecord) }) },
    },
    handler: async (request) => ({ items: await ProjectService.list(request.ctx, request.query) }),
  })

  route({
    method: 'POST',
    url: '/projects',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Создать проект',
    schema: { body: ProjectCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        ProjectService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/projects/:id',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Проект: ключ, руководитель, рабочий процесс, счётчики задач',
    schema: { params: IdParam, response: { 200: ProjectRecord } },
    handler: async (request) => ProjectService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/projects/:id',
    auth: 'session',
    tags: ['tasks'],
    summary: 'Изменить проект',
    schema: { params: IdParam, body: ProjectUpdateInput, response: { 200: ProjectRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        ProjectService.update(tx, request.ctx, request.params.id, request.body),
      )
      return ProjectService.get(request.ctx, request.params.id)
    },
  })
}
