import {
  ManualRuleList,
  ManualRulesQuery,
  RuleCatalog,
  RuleCreateInput,
  RuleDefinition,
  RuleDryRunInput,
  RuleDryRunResult,
  RuleEnabledInput,
  RuleList,
  RuleListQuery,
  RuleRecord,
  RuleRunList,
  RuleRunListQuery,
  RuleRunNowInput,
  RuleRunRecord,
  RuleRunStarted,
  RuleTemplateList,
  RuleUpdateInput,
  RuleValidateInput,
  RuleValidateResult,
} from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ruleCatalog } from './domain/catalog.js'
import { dryRun } from './domain/dry-run.js'
import { RuleService } from './domain/rule-service.js'
import { RuleRuns } from './domain/runs.js'
import { runManually, syncRuleSchedule } from './domain/schedules.js'
import { RULE_TEMPLATES } from './domain/templates.js'
import { checkRule, ruleAllowlist, ruleIssuesOk } from './domain/validate.js'

const IdParam = z.object({ id: z.uuid() })
const Ok = z.object({ ok: z.boolean() })

/**
 * Правила автоматизации (14-automation-integrations.md §1): список по
 * пространствам, конструктор, тестовый прогон, история запусков, ручной
 * запуск у объекта и входящий вызов правила.
 */
export function registerAutomationRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/automation/rules',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Правила автоматизации по пространствам',
    schema: { querystring: RuleListQuery, response: { 200: RuleList } },
    handler: async (request) => RuleService.list(request.ctx, request.query),
  })

  route({
    method: 'POST',
    url: '/automation/rules',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Создать правило',
    schema: { body: RuleCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      const id = await db().transaction((tx) => RuleService.create(tx, request.ctx, request.body))
      await syncRuleSchedule(id)
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/automation/rules/:id',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'Правило: определение, служебный пользователь, статистика',
    schema: { params: IdParam, response: { 200: RuleRecord } },
    handler: async (request) => RuleService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PUT',
    url: '/automation/rules/:id',
    auth: { action: 'manage' },
    tags: ['automation'],
    summary: 'Изменить правило',
    schema: { params: IdParam, body: RuleUpdateInput, response: { 200: RuleRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        RuleService.update(tx, request.ctx, request.params.id, request.body.definition),
      )
      await syncRuleSchedule(request.params.id)
      return RuleService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/automation/rules/:id/enabled',
    auth: { action: 'manage' },
    tags: ['automation'],
    summary: 'Включить или выключить правило',
    schema: { params: IdParam, body: RuleEnabledInput, response: { 200: RuleRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        RuleService.setEnabled(tx, request.ctx, request.params.id, request.body.enabled),
      )
      await syncRuleSchedule(request.params.id)
      return RuleService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/automation/rules/validate',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Проверить определение правила: ошибки и предупреждения',
    readOnly: true,
    schema: { body: RuleValidateInput, response: { 200: RuleValidateResult } },
    handler: async (request) => {
      const issues = checkRule(RuleDefinition.parse(request.body.definition), await ruleAllowlist())
      return { ok: ruleIssuesOk(issues), issues }
    },
  })

  route({
    method: 'POST',
    url: '/automation/rules/dry-run',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Тестовый прогон: что бы произошло на последних событиях',
    readOnly: true,
    schema: { body: RuleDryRunInput, response: { 200: RuleDryRunResult } },
    handler: async (request) =>
      dryRun(request.ctx, RuleDefinition.parse(request.body.definition), request.body.limit),
  })

  route({
    method: 'GET',
    url: '/automation/rules/:id/runs',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'История запусков правила с диагностикой',
    schema: { params: IdParam, querystring: RuleRunListQuery, response: { 200: RuleRunList } },
    handler: async (request) => RuleRuns.list(request.params.id, request.query),
  })

  route({
    method: 'GET',
    url: '/automation/runs/:id',
    auth: 'session',
    tags: ['automation'],
    summary: 'Запуск правила: шаги и диагностика',
    schema: { params: IdParam, response: { 200: RuleRunRecord } },
    handler: async (request) => {
      const run = await RuleRuns.get(request.params.id)
      if (!run) throw errors.notFound('Запуск правила')
      await authorize(request.ctx, 'view', run.ruleId)
      return run
    },
  })

  route({
    method: 'POST',
    url: '/automation/rules/:id/run',
    auth: { action: 'view' },
    tags: ['automation'],
    summary: 'Запустить правило вручную (кнопка у объекта)',
    schema: { params: IdParam, body: RuleRunNowInput, response: { 200: RuleRunStarted } },
    handler: async (request) => {
      const rule = await RuleService.load(db(), request.params.id)
      if (!rule) throw errors.notFound('Правило')
      return { runId: await runManually(request.ctx, rule, request.body.objectId) }
    },
  })

  route({
    method: 'GET',
    url: '/automation/manual-rules',
    auth: 'session',
    tags: ['automation'],
    summary: 'Правила с кнопкой у объекта: меню «⋯» карточки',
    schema: { querystring: ManualRulesQuery, response: { 200: ManualRuleList } },
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
    method: 'GET',
    url: '/automation/templates',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Галерея шаблонов правил',
    schema: { response: { 200: RuleTemplateList } },
    handler: async () => ({ items: RULE_TEMPLATES }),
  })

  route({
    method: 'GET',
    url: '/automation/catalog',
    auth: { capability: 'automation.manage' },
    tags: ['automation'],
    summary: 'Подсказки конструктора: события, поля типов, маршруты',
    schema: { response: { 200: RuleCatalog } },
    handler: async () => ruleCatalog(),
  })

  /**
   * Входящий вызов правила: адрес с секретом, без сессии. Публикует
   * `webhook.received` — правило подхватывает его как обычное событие
   * (14-automation-integrations.md §4).
   */
  route({
    method: 'POST',
    url: '/hooks/rules/:id/:token',
    auth: 'public',
    tags: ['automation'],
    summary: 'Входящий вызов правила',
    rateLimit: { max: 60, timeWindow: '1 minute' },
    schema: {
      params: z.object({ id: z.uuid(), token: z.string().min(16).max(64) }),
      body: z.record(z.string(), z.unknown()).optional(),
      response: { 200: Ok },
    },
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
