import type { RouteRegistrar } from '~/shared/http/route.js'
import { ProtocolAssist } from '../domain/protocol-assist.js'
import { ProtocolService } from '../domain/protocol-service.js'

/**
 * Протокол встречи (11-communications-meetings.md §4, ADR-0093). Тело правится
 * совместно через `/collab` (ADR-0070), здесь — заведение, черновик ИИ,
 * подтверждение с поручениями, регистрация документом и ознакомление.
 */
export function registerProtocolRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /meetings/:id/protocol',
    auth: { delegated: 'ProtocolService.ofMeeting', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Протокол встречи: блоки, поручения, права',
    description: 'Снимок совместного документа; null — протокол ещё не заведён.',
    handler: async (request) => ({
      protocol: await ProtocolService.ofMeeting(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'POST /meetings/:id/protocol',
    auth: { delegated: 'ProtocolService.create', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Завести протокол встречи (он же повестка до неё)',
    handler: async (request) => ProtocolService.create(request.ctx, request.params.id),
  })

  route({
    route: 'GET /protocols/:id',
    auth: { delegated: 'ProtocolService.get', objectType: 'protocol' },
    tags: ['meetings'],
    summary: 'Протокол: блоки, поручения, состояние',
    handler: async (request) => ProtocolService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /protocols/:id/blocks',
    auth: { delegated: 'ProtocolService.addBlocks', objectType: 'protocol' },
    tags: ['meetings'],
    summary: 'Добавить блоки в протокол',
    description: 'Блоки сразу появляются у всех, кто открыл протокол.',
    handler: async (request) =>
      ProtocolService.addBlocks(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /protocols/:id/draft',
    auth: { delegated: 'ProtocolAssist.draft', objectType: 'protocol' },
    tags: ['meetings'],
    summary: 'Черновик ИИ: резюме, решения и предложенные поручения',
    description:
      'Блоки дописываются в документ предложением — поручения создаёт только подтверждение.',
    handler: async (request) => ProtocolAssist.draft(request.ctx, request.params.id),
  })

  route({
    route: 'POST /protocols/:id/confirm',
    auth: { delegated: 'ProtocolService.confirm', objectType: 'protocol' },
    tags: ['meetings'],
    summary: 'Подтвердить протокол: блоки-поручения становятся поручениями',
    handler: async (request) => ProtocolService.confirm(request.ctx, request.params.id),
  })

  route({
    route: 'POST /protocols/:id/register',
    auth: { delegated: 'ProtocolService.register', objectType: 'protocol' },
    tags: ['meetings'],
    summary: 'Зарегистрировать протокол документом выбранного типа',
    handler: async (request) =>
      ProtocolService.register(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /protocols/:id/print',
    auth: { delegated: 'ProtocolService.print', objectType: 'protocol' },
    tags: ['meetings'],
    summary: 'Собрать печатную форму протокола заново — первой версией документа',
    description:
      'При регистрации форма заказывается сама (N32, ADR-0137); повтор — если сборка не удалась.',
    handler: async (request) => ProtocolService.print(request.ctx, request.params.id),
  })

  route({
    route: 'POST /protocols/:id/acknowledgments',
    auth: { delegated: 'ProtocolService.requestAcknowledgment', objectType: 'protocol' },
    tags: ['meetings'],
    summary: 'Отправить протокол участникам на ознакомление',
    handler: async (request) =>
      ProtocolService.requestAcknowledgment(request.ctx, request.params.id, request.body),
  })
}
