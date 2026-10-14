import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { GovEdmsIntake } from '../domain/gov-edms/intake.js'
import { GovEdmsOutgoing } from '../domain/gov-edms/outgoing.js'

/**
 * Ручной обмен с закрытой государственной системой ЭДО (ADR-0219). Входящие из неё
 * заводит делопроизводитель — способность `documents.register`, как у регистрации;
 * пакет исходящего и отметку о передаче — право `dispatch` на документ, как у отметки
 * об отправке.
 */
export function registerGovEdmsRoutes(route: RouteRegistrar): void {
  route({
    route: 'POST /documents/gov-edms/check',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Какие файлы уже заведены из госЭДО (по SHA-256)',
    handler: async (request) => GovEdmsIntake.check(request.ctx, request.body),
  })

  route({
    route: 'GET /documents/gov-edms/intake',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Очередь «Из госЭДО»',
    handler: async (request) => GovEdmsIntake.list(request.ctx, request.query),
  })

  route({
    route: 'POST /documents/gov-edms/intake',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Черновик входящего из госЭДО; файлы загружаются к нему следом',
    handler: async (request) => GovEdmsIntake.create(request.ctx, request.body),
  })

  route({
    route: 'POST /documents/gov-edms/intake/:id/complete',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Файлы черновика загружены: версия, проверка повтора, реквизиты из текста',
    handler: async (request) =>
      GovEdmsIntake.complete(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'GET /documents/:id/gov-edms',
    auth: { delegated: 'GovEdmsOutgoing.state', objectType: 'document' },
    tags: ['documents'],
    summary: 'Исходящий в госЭДО: адресат, ждёт ли передачи, отметки о передаче',
    handler: async (request) => GovEdmsOutgoing.state(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/gov-edms/package',
    auth: { delegated: 'GovEdmsOutgoing.package', objectType: 'document' },
    tags: ['documents'],
    summary: 'Пакет для ручной загрузки в госЭДО (ZIP: экземпляр, приложения, карточка)',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) => GovEdmsOutgoing.package(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/gov-edms/transferred',
    auth: { delegated: 'Correspondence.dispatch', objectType: 'document' },
    tags: ['documents'],
    summary: 'Отметить: пакет передан в госЭДО (дата и номер в госсистеме)',
    handler: async (request) =>
      db().transaction((tx) =>
        GovEdmsOutgoing.transferred(tx, request.ctx, request.params.id, request.body),
      ),
  })
}
