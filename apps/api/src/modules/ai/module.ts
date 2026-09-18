import { AiStatus } from '@kchs/contracts'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AiService } from './domain/service.js'

export function registerAiRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/ai/status',
    auth: 'session',
    tags: ['ai'],
    summary: 'ИИ: включён ли для пользователя, провайдер и суточные лимиты',
    schema: { response: { 200: AiStatus } },
    handler: async (request) => AiService.status(request.ctx),
  })
}
