import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { FormControlService } from './domain/form-control.js'
import { FormService } from './domain/form-service.js'
import { SubmissionService } from './domain/submission-service.js'

/**
 * Формы сбора данных (06-analytics-engine.md §13): ведение форм, заполнение и
 * контроль сдачи. Права — обычные права объекта: сдаёт назначенный, принимает
 * ответственный, ведёт форму тот, кто ею распоряжается.
 */
export function registerFormRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /forms',
    auth: 'session',
    tags: ['forms'],
    summary: 'Формы сбора данных: видимые смотрящему',
    handler: async (request) => FormService.list(request.ctx, request.query),
  })

  route({
    route: 'GET /forms/duties',
    auth: 'session',
    tags: ['forms'],
    summary: 'Что предстоит сдать смотрящему: формы, назначения и периоды',
    handler: async (request) => FormControlService.duties(request.ctx),
  })

  route({
    route: 'POST /forms',
    auth: 'session',
    tags: ['forms'],
    summary: 'Создать форму сбора данных',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      // Форма пишет строки датасета — её заводит тот, кто датасетом распоряжается
      await authorize(request.ctx, 'manage', request.body.definition.datasetId)
      const id = await db().transaction((tx) => FormService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /forms/:id',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Форма: определение, датасет, назначения',
    handler: async (request) => FormService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PUT /forms/:id',
    auth: { action: 'manage' },
    tags: ['forms'],
    summary: 'Изменить форму',
    handler: async (request) => {
      await db().transaction((tx) =>
        FormService.update(tx, request.ctx, request.params.id, request.body),
      )
      return FormService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /forms/:id/enabled',
    auth: { action: 'manage' },
    tags: ['forms'],
    summary: 'Включить или выключить сбор',
    handler: async (request) => {
      await db().transaction((tx) =>
        FormService.setEnabled(tx, request.ctx, request.params.id, request.body.enabled),
      )
      return FormService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /forms/:id/schema',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Поля экрана заполнения',
    handler: async (request) => FormService.schema(request.ctx, request.params.id),
  })

  route({
    route: 'GET /forms/:id/control',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Контроль сдачи: матрица «назначения × периоды»',
    handler: async (request) =>
      FormControlService.matrix(request.ctx, request.params.id, request.query),
  })

  route({
    route: 'POST /forms/:id/submissions',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Открыть отправку периода: черновик или уже начатая сводка',
    handler: async (request) =>
      SubmissionService.open(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'GET /forms/submissions/:sid',
    auth: { delegated: 'SubmissionService.get', resource: 'submission' },
    tags: ['forms'],
    summary: 'Отправка формы',
    handler: async (request) => SubmissionService.get(request.ctx, request.params.sid),
  })

  route({
    route: 'PUT /forms/submissions/:sid',
    auth: { delegated: 'SubmissionService.save', resource: 'submission' },
    tags: ['forms'],
    summary: 'Сохранить черновик сводки',
    handler: async (request) =>
      SubmissionService.save(request.ctx, request.params.sid, request.body),
  })

  route({
    route: 'POST /forms/submissions/:sid/submit',
    auth: { delegated: 'SubmissionService.submit', resource: 'submission' },
    tags: ['forms'],
    summary: 'Сдать сводку: строка датасета (у табличной формы — строки) с `_import_id` отправки',
    handler: async (request) =>
      SubmissionService.submit(request.ctx, request.params.sid, request.body),
  })

  route({
    route: 'POST /forms/submissions/:sid/review',
    auth: { delegated: 'SubmissionService.review', resource: 'submission' },
    tags: ['forms'],
    summary: 'Принять сводку или вернуть с комментарием',
    handler: async (request) =>
      SubmissionService.review(request.ctx, request.params.sid, request.body),
  })
}
