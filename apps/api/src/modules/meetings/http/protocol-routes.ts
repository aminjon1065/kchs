import {
  ProtocolAcknowledgeInput,
  ProtocolDraft,
  ProtocolRecord,
  ProtocolRegisterInput,
  ProtocolResponse,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ProtocolAssist } from '../domain/protocol-assist.js'
import { ProtocolService } from '../domain/protocol-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Протокол встречи (11-communications-meetings.md §4, ADR-0093). Тело правится
 * совместно через `/collab` (ADR-0070), здесь — заведение, черновик ИИ,
 * подтверждение с поручениями, регистрация документом и ознакомление.
 */
export function registerProtocolRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/meetings/:id/protocol',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Протокол встречи: блоки, поручения, права',
    description: 'Снимок совместного документа; null — протокол ещё не заведён.',
    schema: { params: IdParam, response: { 200: ProtocolResponse } },
    handler: async (request) => ({
      protocol: await ProtocolService.ofMeeting(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'POST',
    url: '/meetings/:id/protocol',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Завести протокол встречи (он же повестка до неё)',
    schema: { params: IdParam, response: { 200: ProtocolRecord } },
    handler: async (request) => ProtocolService.create(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/protocols/:id',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Протокол: блоки, поручения, состояние',
    schema: { params: IdParam, response: { 200: ProtocolRecord } },
    handler: async (request) => ProtocolService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/protocols/:id/draft',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Черновик ИИ: резюме, решения и предложенные поручения',
    description:
      'Блоки дописываются в документ предложением — поручения создаёт только подтверждение.',
    schema: { params: IdParam, response: { 200: ProtocolDraft } },
    handler: async (request) => ProtocolAssist.draft(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/protocols/:id/confirm',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Подтвердить протокол: блоки-поручения становятся поручениями',
    schema: { params: IdParam, response: { 200: ProtocolRecord } },
    handler: async (request) => ProtocolService.confirm(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/protocols/:id/register',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Зарегистрировать протокол документом выбранного типа',
    schema: {
      params: IdParam,
      body: ProtocolRegisterInput,
      response: { 200: z.object({ documentId: z.uuid() }) },
    },
    handler: async (request) =>
      ProtocolService.register(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'POST',
    url: '/protocols/:id/acknowledgments',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Отправить протокол участникам на ознакомление',
    schema: {
      params: IdParam,
      body: ProtocolAcknowledgeInput,
      response: { 200: z.object({ requested: z.number().int() }) },
    },
    handler: async (request) =>
      ProtocolService.requestAcknowledgment(request.ctx, request.params.id, request.body),
  })
}
