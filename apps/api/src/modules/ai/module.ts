import { registerFeature } from '~/kernel/features/registry.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AiService } from './domain/service.js'
import { Translate } from './domain/translate.js'

/**
 * Возможность «Интеллектуальные функции» (15-admin-operations.md §1): выключение
 * закрывает ассистента, перевод и подсказки ИИ независимо от того, настроен ли
 * провайдер. Организация, которой ИИ не положен, выключает его раз и навсегда.
 * Модуль `ai` — шлюз к модели (ADR-0181): провайдеры, лимиты, аудит, перевод; от
 * других модулей он не зависит, ассистент над данными и файлами — модуль `assistant`.
 */
export function registerAiFeature(): void {
  registerFeature({
    key: 'ai',
    titleKey: 'admin.features.items.ai.title',
    hintKey: 'admin.features.items.ai.hint',
    tags: ['ai'],
    screens: ['assistant'],
  })
}

export function registerAiRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /ai/status',
    auth: 'session',
    tags: ['ai'],
    summary: 'ИИ: включён ли для пользователя, провайдер и суточные лимиты',
    handler: async (request) => AiService.status(request.ctx),
  })

  route({
    route: 'POST /ai/translate',
    auth: 'session',
    tags: ['ai'],
    summary: 'Перевод текста между языками платформы (ru, tg, en)',
    handler: async (request) => Translate.run(request.ctx, request.body),
  })
}
