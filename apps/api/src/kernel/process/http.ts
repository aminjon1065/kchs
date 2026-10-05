import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize, loadObject } from '../access/authorize.js'
import { DefinitionService } from './definitions.js'
import {
  processObjectProvider,
  processObjectProviders,
  processStepHandlers,
  waitableEvents,
} from './registry.js'
import { ProcessService } from './service.js'
import { instanceIdOfStep } from './store.js'
import { ProcessView } from './view.js'

const MANAGE = { capability: 'processes.manage' } as const

/** Шаг принадлежит маршруту из адреса: иначе — 404, без раскрытия чужого шага. */
async function assertStep(instanceId: string, stepId: string): Promise<void> {
  if ((await instanceIdOfStep(db(), stepId)) !== instanceId) throw errors.notFound('Шаг маршрута')
}

/**
 * API движка процессов (ADR-0079): определения и предпросмотр назначений —
 * администратору маршрутов (`processes.manage`), экземпляры — тем, кто видит
 * объект; решения — назначенным и их заместителям.
 */
export function registerProcessRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /process-definitions',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Маршруты процессов: версии, черновики, идущие экземпляры',
    handler: async () => ({ items: await DefinitionService.list() }),
  })

  route({
    route: 'GET /process-catalog',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Справочник конструктора маршрутов: типы объектов, поля, события, исполнители шагов',
    handler: async () => ({
      objectTypes: await Promise.all(
        processObjectProviders().map(async (provider) => ({
          type: provider.objectType,
          fields: (await provider.fieldHints?.(db())) ?? [],
          canStart: Boolean(provider.canStart),
        })),
      ),
      waitEvents: [...waitableEvents()].sort(),
      handlers: processStepHandlers().map((handler) => ({
        type: handler.type,
        objectType: handler.objectType ?? null,
        action: handler.action ?? null,
      })),
    }),
  })

  route({
    route: 'POST /process-definitions',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Новый маршрут: черновик версии 1',
    handler: async (request) =>
      db().transaction((tx) => DefinitionService.create(tx, request.ctx, request.body.definition)),
  })

  route({
    route: 'POST /process-definitions/validate',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Проверить определение маршрута без сохранения',
    readOnly: true,
    handler: async (request) => DefinitionService.validate(request.body.definition),
  })

  route({
    route: 'POST /process-definitions/preview',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Предпросмотр «кто будет назначен» на примере объекта',
    readOnly: true,
    handler: async (request) => DefinitionService.preview(request.ctx, request.body),
  })

  route({
    route: 'GET /process-definitions/:key',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Маршрут: опубликованная версия, черновик, история версий',
    handler: async (request) => DefinitionService.details(request.params.key),
  })

  route({
    route: 'GET /process-definitions/:key/versions/:version',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Версия маршрута',
    handler: async (request) =>
      DefinitionService.version(request.params.key, request.params.version),
  })

  route({
    route: 'PUT /process-definitions/:key/draft',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Сохранить черновик маршрута (новая версия после публикованной)',
    handler: async (request) =>
      db().transaction((tx) =>
        DefinitionService.saveDraft(tx, request.ctx, request.params.key, request.body.definition),
      ),
  })

  route({
    route: 'DELETE /process-definitions/:key/draft',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Удалить черновик маршрута',
    handler: async (request) => {
      await db().transaction((tx) =>
        DefinitionService.discardDraft(tx, request.ctx, request.params.key),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /process-definitions/:key/publish',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Опубликовать черновик: новые запуски идут по новой версии',
    handler: async (request) =>
      db().transaction((tx) => DefinitionService.publish(tx, request.ctx, request.params.key)),
  })

  route({
    route: 'POST /processes',
    auth: 'session',
    tags: ['processes'],
    summary: 'Запустить маршрут для объекта (если тип объекта разрешает запуск из API)',
    handler: async (request) => {
      const object = await loadObject(request.body.objectId)
      if (!object || object.deletedAt) throw errors.notFound()
      const provider = processObjectProvider(object.type)
      if (!provider?.canStart) {
        // Не раскрываем объект, который пользователь не видит
        await authorize(request.ctx, 'view', object)
        throw errors.forbidden('Маршрут этого объекта запускает модуль объекта')
      }
      const definition = await DefinitionService.published(db(), {
        key: request.body.definitionKey,
        id: request.body.definitionId,
      })
      await provider.canStart(request.ctx, object.id, {
        key: definition.key,
        version: definition.version,
      })
      const { instanceId } = await db().transaction((tx) =>
        ProcessService.start(tx, request.ctx, {
          objectId: object.id,
          definitionId: definition.id,
          variables: request.body.variables,
          assignees: request.body.assignees,
        }),
      )
      return { id: instanceId }
    },
  })

  route({
    route: 'GET /processes',
    auth: 'session',
    tags: ['processes'],
    summary: 'Маршруты объекта',
    handler: async (request) => ({
      items: await ProcessView.listForObject(request.ctx, request.query.objectId),
    }),
  })

  route({
    route: 'GET /processes/:id',
    auth: { delegated: 'ProcessView.get', resource: 'process' },
    tags: ['processes'],
    summary: 'Маршрут: линия шагов, назначенные, сроки, решения, мои действия',
    handler: async (request) => ProcessView.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /processes/:id/cancel',
    auth: { delegated: 'ProcessService.cancel', resource: 'process' },
    tags: ['processes'],
    summary: 'Отменить маршрут: инициатор, управляющий объектом, администратор маршрутов',
    handler: async (request) => {
      await db().transaction((tx) =>
        ProcessService.cancel(tx, request.ctx, {
          instanceId: request.params.id,
          reason: request.body.reason,
        }),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /processes/:id/steps/:stepId/act',
    auth: { delegated: 'ProcessService.act', resource: 'process' },
    tags: ['processes'],
    summary: 'Решение шага: согласовать, замечания, отклонить, подписать, ознакомиться…',
    handler: async (request) => {
      await assertStep(request.params.id, request.params.stepId)
      await db().transaction((tx) =>
        ProcessService.act(tx, request.ctx, {
          stepId: request.params.stepId,
          action: request.body.action,
          comment: request.body.comment ?? null,
          fileIds: request.body.fileIds,
          code: request.body.code,
        }),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /processes/:id/steps/:stepId/assignees',
    auth: { delegated: 'ProcessService.addAssignee', resource: 'process' },
    tags: ['processes'],
    summary: 'Добавить согласующего (если шаг разрешает)',
    handler: async (request) => {
      await assertStep(request.params.id, request.params.stepId)
      await db().transaction((tx) =>
        ProcessService.addAssignee(tx, request.ctx, {
          stepId: request.params.stepId,
          userId: request.body.userId,
          comment: request.body.comment,
        }),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /processes/:id/steps/:stepId/delegate',
    auth: { delegated: 'ProcessService.delegate', resource: 'process' },
    tags: ['processes'],
    summary: 'Передать свой шаг другому сотруднику',
    handler: async (request) => {
      await assertStep(request.params.id, request.params.stepId)
      await db().transaction((tx) =>
        ProcessService.delegate(tx, request.ctx, {
          stepId: request.params.stepId,
          userId: request.body.userId,
          comment: request.body.comment,
        }),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /processes/:id/steps/:stepId/reassign',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Переназначить шаг (администратор маршрутов)',
    handler: async (request) => {
      await assertStep(request.params.id, request.params.stepId)
      await db().transaction((tx) =>
        ProcessService.reassign(tx, request.ctx, {
          stepId: request.params.stepId,
          fromUserId: request.body.fromUserId,
          userIds: request.body.userIds,
        }),
      )
      return { ok: true }
    },
  })
}
