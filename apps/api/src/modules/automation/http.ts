import { RuleDefinition } from '@kchs/contracts'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ruleCatalog } from './domain/catalog.js'
import { dryRun } from './domain/dry-run.js'
import { RuleService } from './domain/rule-service.js'
import { RuleVersions } from './domain/rule-versions.js'
import { RuleRuns } from './domain/runs.js'
import { runManually, syncRuleSchedule } from './domain/schedules.js'
import { RULE_TEMPLATES } from './domain/templates.js'
import { checkRule, ruleAllowlist, ruleIssuesOk } from './domain/validate.js'

/**
 * Правила автоматизации (14-automation-integrations.md §1): список по
 * пространствам, конструктор, тестовый прогон, история запусков, ручной
 * запуск у объекта и входящий вызов правила.
 */
export function registerAutomationRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /automation/rules',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Правила автоматизации по пространствам',
    handler: async (request) => RuleService.list(request.ctx, request.query),
  })

  route({
    route: 'POST /automation/rules',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Создать правило',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      const id = await db().transaction((tx) => RuleService.create(tx, request.ctx, request.body))
      await syncRuleSchedule(id)
      return { id }
    },
  })

  route({
    route: 'GET /automation/rules/:id',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'Правило: определение, служебный пользователь, статистика',
    handler: async (request) => RuleService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PUT /automation/rules/:id',
    auth: { action: 'manage' },
    tags: ['automation'],
    summary: 'Изменить правило',
    handler: async (request) => {
      await db().transaction((tx) =>
        RuleService.update(tx, request.ctx, request.params.id, request.body.definition),
      )
      await syncRuleSchedule(request.params.id)
      return RuleService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /automation/rules/:id/enabled',
    auth: { action: 'manage' },
    tags: ['automation'],
    summary: 'Включить или выключить правило',
    handler: async (request) => {
      await db().transaction((tx) =>
        RuleService.setEnabled(tx, request.ctx, request.params.id, request.body.enabled),
      )
      await syncRuleSchedule(request.params.id)
      return RuleService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /automation/rules/:id/duplicate',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'Копия правила в том же пространстве (выключенная)',
    handler: async (request) => {
      const rule = await RuleService.load(db(), request.params.id)
      if (!rule?.spaceId) throw errors.notFound('Правило')
      await authorize(request.ctx, 'create_child', rule.spaceId)
      const id = await db().transaction((tx) =>
        RuleService.duplicate(tx, request.ctx, request.params.id),
      )
      return { id }
    },
  })

  route({
    route: 'GET /automation/rules/:id/versions',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'Версии определения правила',
    handler: async (request) => ({ items: await RuleVersions.list(request.params.id) }),
  })

  route({
    route: 'POST /automation/rules/:id/versions/:versionId/restore',
    auth: { action: 'manage' },
    tags: ['automation'],
    summary: 'Откатить правило к версии: её определение становится новой версией',
    handler: async (request) => {
      await db().transaction((tx) =>
        RuleService.restore(tx, request.ctx, request.params.id, request.params.versionId),
      )
      await syncRuleSchedule(request.params.id)
      return RuleService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /automation/rules/:id/export',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'Файл одного правила: определение без секретов и служебного пользователя',
    handler: async (request) => RuleService.exportRule(request.ctx, request.params.id),
  })

  route({
    route: 'POST /automation/rules/import',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Правило из файла: выключенным, без служебного пользователя',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      const id = await db().transaction((tx) =>
        RuleService.importRule(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'POST /automation/rules/validate',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Проверить определение правила: ошибки и предупреждения',
    readOnly: true,
    handler: async (request) => {
      const issues = checkRule(RuleDefinition.parse(request.body.definition), await ruleAllowlist())
      return { ok: ruleIssuesOk(issues), issues }
    },
  })

  route({
    route: 'POST /automation/rules/dry-run',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Тестовый прогон: что бы произошло на последних событиях',
    readOnly: true,
    handler: async (request) =>
      dryRun(request.ctx, RuleDefinition.parse(request.body.definition), request.body.limit),
  })

  route({
    route: 'GET /automation/rules/:id/runs',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'История запусков правила с диагностикой',
    handler: async (request) => RuleRuns.list(request.params.id, request.query),
  })

  route({
    route: 'GET /automation/runs/:id',
    auth: { delegated: 'authorize(view)', resource: 'rule_run' },
    tags: ['automation'],
    summary: 'Запуск правила: шаги и диагностика',
    handler: async (request) => {
      const run = await RuleRuns.get(request.params.id)
      if (!run) throw errors.notFound('Запуск правила')
      await authorize(request.ctx, 'view', run.ruleId)
      return run
    },
  })

  route({
    route: 'POST /automation/rules/:id/run',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'Запустить правило вручную (кнопка у объекта)',
    handler: async (request) => {
      const rule = await RuleService.load(db(), request.params.id)
      if (!rule) throw errors.notFound('Правило')
      return { runId: await runManually(request.ctx, rule, request.body.objectId) }
    },
  })

  route({
    route: 'GET /automation/manual-rules',
    auth: 'session',
    tags: ['automation'],
    summary: 'Правила с кнопкой у объекта: меню «⋯» карточки',
    handler: async (request) => {
      const decision = await authorize(request.ctx, 'view', request.query.objectId, { soft: true })
      if (!decision.allowed) return { items: [] }
      const { loadObject } = await import('~/kernel/access/authorize.js')
      const object = await loadObject(request.query.objectId)
      if (!object) return { items: [] }
      const rules = await RuleService.manualFor(object.type)
      return {
        items: rules.map((rule) => {
          const definition = RuleDefinition.parse(rule.definition)
          return {
            id: rule.id,
            name: definition.name,
            description: definition.description,
            confirm: definition.trigger.kind === 'manual' ? definition.trigger.confirm : false,
          }
        }),
      }
    },
  })

  route({
    route: 'GET /automation/templates',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Галерея шаблонов правил',
    handler: async () => ({ items: RULE_TEMPLATES }),
  })

  route({
    route: 'GET /automation/catalog',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Подсказки конструктора: события, поля типов, маршруты',
    handler: async () => ruleCatalog(),
  })

  /**
   * Входящий вызов правила: адрес с секретом, без сессии. Публикует
   * `webhook.received` — правило подхватывает его как обычное событие
   * (14-automation-integrations.md §4).
   */
  route({
    route: 'POST /hooks/rules/:id/:token',
    auth: 'public',
    tags: ['automation'],
    summary: 'Входящий вызов правила',
    rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async (request) => {
      const rule = await RuleService.load(db(), request.params.id)
      if (!rule?.enabled || !rule.webhookToken) throw errors.notFound('Вызов')
      if (rule.webhookToken !== request.params.token) throw errors.notFound('Вызов')
      const definition = RuleDefinition.parse(rule.definition)
      const hookKey = definition.trigger.kind === 'webhook' ? definition.trigger.hookKey : rule.key
      await db().transaction((tx) =>
        publishEvent(tx, systemCtx('automation.hook'), {
          type: 'webhook.received',
          object: { id: rule.id, type: 'rule', spaceId: rule.spaceId, title: rule.title },
          payload: {
            source: 'rule',
            integrationId: null,
            hookKey,
            kind: '',
            body: (request.body ?? {}) as Record<string, unknown>,
            signature: null,
          },
        }),
      )
      return { ok: true }
    },
  })
}
