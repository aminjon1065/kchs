import {
  ProjectCreateInput,
  ProjectListQuery,
  ProjectRecord,
  ProjectUpdateInput,
  TaskCancelInput,
  TaskCreateInput,
  TaskList,
  TaskListQuery,
  TaskRecord,
  TaskReportInput,
  TaskReturnInput,
  TaskStatusInput,
  TaskSummary,
  TaskUpdateInput,
} from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerInboxActionHandler } from '~/kernel/inbox/actions.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { registerSystemDataset } from '~/kernel/system-datasets.js'
import { db } from '~/shared/db/client.js'
import { objects, projects, tasks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ProjectService } from './domain/project-service.js'
import { TASKS_SYSTEM_DATASET } from './domain/system-dataset.js'
import { TaskService } from './domain/task-service.js'
import { taskSubscribers } from './domain/task-subscribers.js'

const IdParam = z.object({ id: z.uuid() })
const RowSourceQuery = z.object({
  datasetId: z.uuid(),
  rowId: z.string().regex(/^\d{1,18}$/),
})

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

  // Кнопки поручения во Входящих (и в Telegram) исполняет модуль задач
  registerInboxActionHandler('accept_instruction', async (ctx, { item, action }) => {
    if (action !== 'accept' || !item.objectId) throw errors.validation('Нет такого действия')
    const taskId = item.objectId
    await db().transaction((tx) => TaskService.start(tx, ctx, taskId))
  })
  registerInboxActionHandler('report_instruction', async (ctx, { item, action, comment }) => {
    if (action !== 'report' || !item.objectId || !comment) {
      throw errors.validation('Отчёт — текстом об исполнении')
    }
    const taskId = item.objectId
    await db().transaction((tx) => TaskService.report(tx, ctx, taskId, { text: comment }))
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

/** Подписчики модуля — только в роли worker. */
export function registerTasksBackground(): void {
  for (const subscriber of taskSubscribers) registerSubscriber(subscriber)
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
