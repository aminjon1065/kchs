import {
  FormControl,
  FormControlQuery,
  FormCreateInput,
  FormDutyList,
  FormEnabledInput,
  FormList,
  FormListQuery,
  FormRecord,
  FormReviewInput,
  FormSchema,
  FormSubmission,
  FormSubmissionOpenInput,
  FormSubmissionSaveInput,
  FormUpdateInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { FormControlService } from './domain/form-control.js'
import { FormService } from './domain/form-service.js'
import { SubmissionService } from './domain/submission-service.js'

const IdParam = z.object({ id: z.uuid() })
const SubmissionParam = z.object({ sid: z.uuid() })

/**
 * Формы сбора данных (06-analytics-engine.md §13): ведение форм, заполнение и
 * контроль сдачи. Права — обычные права объекта: сдаёт назначенный, принимает
 * ответственный, ведёт форму тот, кто ею распоряжается.
 */
export function registerFormRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/forms',
    auth: 'session',
    tags: ['forms'],
    summary: 'Формы сбора данных: видимые смотрящему',
    schema: { querystring: FormListQuery, response: { 200: FormList } },
    handler: async (request) => FormService.list(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/forms/duties',
    auth: 'session',
    tags: ['forms'],
    summary: 'Что предстоит сдать смотрящему: формы, назначения и периоды',
    schema: { response: { 200: FormDutyList } },
    handler: async (request) => FormControlService.duties(request.ctx),
  })

  route({
    method: 'POST',
    url: '/forms',
    auth: 'session',
    tags: ['forms'],
    summary: 'Создать форму сбора данных',
    schema: { body: FormCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      // Форма пишет строки датасета — её заводит тот, кто датасетом распоряжается
      await authorize(request.ctx, 'manage', request.body.definition.datasetId)
      const id = await db().transaction((tx) => FormService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/forms/:id',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Форма: определение, датасет, назначения',
    schema: { params: IdParam, response: { 200: FormRecord } },
    handler: async (request) => FormService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PUT',
    url: '/forms/:id',
    auth: { action: 'manage' },
    tags: ['forms'],
    summary: 'Изменить форму',
    schema: { params: IdParam, body: FormUpdateInput, response: { 200: FormRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        FormService.update(tx, request.ctx, request.params.id, request.body),
      )
      return FormService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/forms/:id/enabled',
    auth: { action: 'manage' },
    tags: ['forms'],
    summary: 'Включить или выключить сбор',
    schema: { params: IdParam, body: FormEnabledInput, response: { 200: FormRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        FormService.setEnabled(tx, request.ctx, request.params.id, request.body.enabled),
      )
      return FormService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/forms/:id/schema',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Поля экрана заполнения',
    schema: { params: IdParam, response: { 200: FormSchema } },
    handler: async (request) => FormService.schema(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/forms/:id/control',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Контроль сдачи: матрица «назначения × периоды»',
    schema: { params: IdParam, querystring: FormControlQuery, response: { 200: FormControl } },
    handler: async (request) =>
      FormControlService.matrix(request.ctx, request.params.id, request.query),
  })

  route({
    method: 'POST',
    url: '/forms/:id/submissions',
    auth: { action: 'view' },
    tags: ['forms'],
    summary: 'Открыть отправку периода: черновик или уже начатая сводка',
    schema: {
      params: IdParam,
      body: FormSubmissionOpenInput,
      response: { 200: FormSubmission },
    },
    handler: async (request) =>
      SubmissionService.open(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'GET',
    url: '/forms/submissions/:sid',
    auth: 'session',
    tags: ['forms'],
    summary: 'Отправка формы',
    schema: { params: SubmissionParam, response: { 200: FormSubmission } },
    handler: async (request) => SubmissionService.get(request.ctx, request.params.sid),
  })

  route({
    method: 'PUT',
    url: '/forms/submissions/:sid',
    auth: 'session',
    tags: ['forms'],
    summary: 'Сохранить черновик сводки',
    schema: {
      params: SubmissionParam,
      body: FormSubmissionSaveInput,
      response: { 200: FormSubmission },
    },
    handler: async (request) =>
      SubmissionService.save(request.ctx, request.params.sid, request.body.values),
  })

  route({
    method: 'POST',
    url: '/forms/submissions/:sid/submit',
    auth: 'session',
    tags: ['forms'],
    summary: 'Сдать сводку: строки датасета с `_import_id` отправки',
    schema: {
      params: SubmissionParam,
      body: FormSubmissionSaveInput,
      response: { 200: FormSubmission },
    },
    handler: async (request) =>
      SubmissionService.submit(request.ctx, request.params.sid, request.body.values),
  })

  route({
    method: 'POST',
    url: '/forms/submissions/:sid/review',
    auth: 'session',
    tags: ['forms'],
    summary: 'Принять сводку или вернуть с комментарием',
    schema: {
      params: SubmissionParam,
      body: FormReviewInput,
      response: { 200: FormSubmission },
    },
    handler: async (request) =>
      SubmissionService.review(request.ctx, request.params.sid, request.body),
  })
}
