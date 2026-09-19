import {
  ProcessActInput,
  ProcessAssigneeInput,
  ProcessCancelInput,
  ProcessDefinitionDetails,
  ProcessDefinitionSummary,
  ProcessDefinitionVersion,
  ProcessDraftInput,
  ProcessDraftSaved,
  ProcessInstanceSummary,
  ProcessInstanceView,
  ProcessPreview,
  ProcessPreviewInput,
  ProcessReassignInput,
  ProcessStartInput,
  ProcessValidateInput,
  ProcessValidation,
} from '@kchs/process'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize, loadObject } from '../access/authorize.js'
import { DefinitionService } from './definitions.js'
import { processObjectProvider } from './registry.js'
import { ProcessService } from './service.js'
import { instanceIdOfStep } from './store.js'
import { ProcessView } from './view.js'

const MANAGE = { capability: 'processes.manage' } as const
const Ok = z.object({ ok: z.boolean() })
const KeyParam = z.object({ key: z.string().min(1).max(64) })
const StepParams = z.object({ id: z.uuid(), stepId: z.uuid() })

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
    method: 'GET',
    url: '/process-definitions',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Маршруты процессов: версии, черновики, идущие экземпляры',
    schema: { response: { 200: z.object({ items: z.array(ProcessDefinitionSummary) }) } },
    handler: async () => ({ items: await DefinitionService.list() }),
  })

  route({
    method: 'POST',
    url: '/process-definitions',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Новый маршрут: черновик версии 1',
    schema: { body: ProcessDraftInput, response: { 200: ProcessDraftSaved } },
    handler: async (request) =>
      db().transaction((tx) => DefinitionService.create(tx, request.ctx, request.body.definition)),
  })

  route({
    method: 'POST',
    url: '/process-definitions/validate',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Проверить определение маршрута без сохранения',
    readOnly: true,
    schema: { body: ProcessValidateInput, response: { 200: ProcessValidation } },
    handler: async (request) => DefinitionService.validate(request.body.definition),
  })

  route({
    method: 'POST',
    url: '/process-definitions/preview',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Предпросмотр «кто будет назначен» на примере объекта',
    readOnly: true,
    schema: { body: ProcessPreviewInput, response: { 200: ProcessPreview } },
    handler: async (request) => DefinitionService.preview(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/process-definitions/:key',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Маршрут: опубликованная версия, черновик, история версий',
    schema: { params: KeyParam, response: { 200: ProcessDefinitionDetails } },
    handler: async (request) => DefinitionService.details(request.params.key),
  })

  route({
    method: 'GET',
    url: '/process-definitions/:key/versions/:version',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Версия маршрута',
    schema: {
      params: KeyParam.extend({ version: z.coerce.number().int().min(1) }),
      response: { 200: ProcessDefinitionVersion },
    },
    handler: async (request) =>
      DefinitionService.version(request.params.key, request.params.version),
  })

  route({
    method: 'PUT',
    url: '/process-definitions/:key/draft',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Сохранить черновик маршрута (новая версия после публикованной)',
    schema: { params: KeyParam, body: ProcessDraftInput, response: { 200: ProcessDraftSaved } },
    handler: async (request) =>
      db().transaction((tx) =>
        DefinitionService.saveDraft(tx, request.ctx, request.params.key, request.body.definition),
      ),
  })

  route({
    method: 'DELETE',
    url: '/process-definitions/:key/draft',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Удалить черновик маршрута',
    schema: { params: KeyParam, response: { 200: Ok } },
    handler: async (request) => {
      await db().transaction((tx) =>
        DefinitionService.discardDraft(tx, request.ctx, request.params.key),
      )
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/process-definitions/:key/publish',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Опубликовать черновик: новые запуски идут по новой версии',
    schema: { params: KeyParam, response: { 200: ProcessDefinitionVersion } },
    handler: async (request) =>
      db().transaction((tx) => DefinitionService.publish(tx, request.ctx, request.params.key)),
  })

  route({
    method: 'POST',
    url: '/processes',
    auth: 'session',
    tags: ['processes'],
    summary: 'Запустить маршрут для объекта (если тип объекта разрешает запуск из API)',
    schema: { body: ProcessStartInput, response: { 200: z.object({ id: z.uuid() }) } },
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
    method: 'GET',
    url: '/processes',
    auth: 'session',
    tags: ['processes'],
    summary: 'Маршруты объекта',
    schema: {
      querystring: z.object({ objectId: z.uuid() }),
      response: { 200: z.object({ items: z.array(ProcessInstanceSummary) }) },
    },
    handler: async (request) => ({
      items: await ProcessView.listForObject(request.ctx, request.query.objectId),
    }),
  })

  route({
    method: 'GET',
    url: '/processes/:id',
    auth: 'session',
    tags: ['processes'],
    summary: 'Маршрут: линия шагов, назначенные, сроки, решения, мои действия',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: ProcessInstanceView } },
    handler: async (request) => ProcessView.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/processes/:id/cancel',
    auth: 'session',
    tags: ['processes'],
    summary: 'Отменить маршрут: инициатор, управляющий объектом, администратор маршрутов',
    schema: { params: z.object({ id: z.uuid() }), body: ProcessCancelInput, response: { 200: Ok } },
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
    method: 'POST',
    url: '/processes/:id/steps/:stepId/act',
    auth: 'session',
    tags: ['processes'],
    summary: 'Решение шага: согласовать, замечания, отклонить, подписать, ознакомиться…',
    schema: { params: StepParams, body: ProcessActInput, response: { 200: Ok } },
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
    method: 'POST',
    url: '/processes/:id/steps/:stepId/assignees',
    auth: 'session',
    tags: ['processes'],
    summary: 'Добавить согласующего (если шаг разрешает)',
    schema: { params: StepParams, body: ProcessAssigneeInput, response: { 200: Ok } },
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
    method: 'POST',
    url: '/processes/:id/steps/:stepId/delegate',
    auth: 'session',
    tags: ['processes'],
    summary: 'Передать свой шаг другому сотруднику',
    schema: { params: StepParams, body: ProcessAssigneeInput, response: { 200: Ok } },
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
    method: 'POST',
    url: '/processes/:id/steps/:stepId/reassign',
    auth: MANAGE,
    tags: ['processes'],
    summary: 'Переназначить шаг (администратор маршрутов)',
    schema: { params: StepParams, body: ProcessReassignInput, response: { 200: Ok } },
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
