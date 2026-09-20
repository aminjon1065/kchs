import type { EventEnvelope, RuleDefinition } from '@kchs/contracts'
import { RuleDefinition as RuleDefinitionSchema } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  evaluateRuleCondition,
  renderTemplate,
  renderValue,
  ruleScope,
  scopeFromEvent,
  templateExpressions,
} from './scope.js'
import { matchesFilter, matchesTrigger } from './triggers.js'
import { checkRule, ruleIssuesOk } from './validate.js'

const OBJECT_ID = '0192a000-0000-7000-8000-000000000001'
const USER_ID = '0192a000-0000-7000-8000-000000000002'

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'evt-1',
    type: 'document.registered',
    version: 1,
    occurredAt: '2026-09-20T08:00:00.000Z',
    actor: { kind: 'user', userId: USER_ID, onBehalfOf: null, sessionId: null },
    object: { id: OBJECT_ID, type: 'document', spaceId: null, title: 'Договор №7' },
    target: null,
    payload: { regNumber: '7-К/2026', typeKey: 'contract' },
    changedFields: null,
    correlationId: null,
    causationId: null,
    source: 'api',
    visibility: null,
    ...overrides,
  } as EventEnvelope
}

function rule(overrides: Record<string, unknown> = {}): RuleDefinition {
  return RuleDefinitionSchema.parse({
    name: { ru: 'Правило' },
    runAs: USER_ID,
    trigger: { kind: 'event', type: 'document.registered', filter: {} },
    actions: [{ type: 'notify', to: [`user:${USER_ID}`], text: 'Привет' }],
    ...overrides,
  })
}

describe('область вычисления правила', () => {
  const scope = ruleScope(
    {
      ...scopeFromEvent(event(), new Date('2026-09-20T09:00:00.000Z')),
      object: {
        id: OBJECT_ID,
        type: 'document',
        title: 'Договор №7',
        spaceId: null,
        fields: { amount: 1_500_000, responsibleId: USER_ID },
      },
      previous: { amount: 100 },
    },
    'UTC',
  )

  it('читает событие, объект, поля карточки и «сейчас»', () => {
    expect(renderValue('{{event.payload.regNumber}}', scope)).toBe('7-К/2026')
    expect(renderValue('{{object.fields.amount}}', scope)).toBe(1_500_000)
    expect(renderTemplate('Сумма: {{object.fields.amount}}', scope)).toBe('Сумма: 1500000')
    expect(renderValue('{{now}}', scope)).toBe('2026-09-20T09:00:00.000Z')
    expect(renderValue('{{actor.id}}', scope)).toBe(USER_ID)
  })

  it('вычисляет дерево условий and/or/not по правилам SQL', () => {
    expect(evaluateRuleCondition({ expr: 'object.fields.amount >= 1000000' }, scope)).toBe(true)
    expect(
      evaluateRuleCondition(
        { and: [{ expr: "object.type == 'document'" }, { expr: 'previous.amount < 1000' }] },
        scope,
      ),
    ).toBe(true)
    expect(
      evaluateRuleCondition(
        { or: [{ expr: '1 = 2' }, { expr: 'object.fields.amount > 0' }] },
        scope,
      ),
    ).toBe(true)
    expect(evaluateRuleCondition({ not: { expr: 'object.fields.amount > 0' } }, scope)).toBe(false)
    // Неизвестная ссылка — null, а не истина: условие не выполнено
    expect(evaluateRuleCondition({ expr: 'object.fields.missing > 0' }, scope)).toBe(false)
  })

  it('находит выражения шаблона', () => {
    expect(templateExpressions('{{object.id}} и {{ object.title }}')).toEqual([
      'object.id',
      'object.title',
    ])
  })
})

describe('отбор события триггером', () => {
  it('сравнивает тип и поля конверта', () => {
    expect(matchesTrigger(rule(), event())).toBe(true)
    expect(matchesTrigger(rule(), event({ type: 'document.created' }))).toBe(false)
    expect(
      matchesTrigger(
        rule({ trigger: { kind: 'event', type: 'document.*', filter: {} } }),
        event({ type: 'document.created' }),
      ),
    ).toBe(true)
  })

  it('отбор по полю конверта отсеивает чужие события', () => {
    expect(matchesFilter(event(), { 'object.type': 'document' })).toBe(true)
    expect(matchesFilter(event(), { 'object.type': 'task' })).toBe(false)
    expect(matchesFilter(event(), { 'payload.typeKey': ['contract', 'order'] })).toBe(true)
    expect(matchesFilter(event(), { causationId: null })).toBe(true)
  })

  it('правило не с событийным триггером не сравнивается с событиями', () => {
    const manual = rule({ trigger: { kind: 'manual', objectTypes: ['document'], confirm: false } })
    expect(matchesTrigger(manual, event())).toBe(false)
  })
})

describe('проверка определения правила', () => {
  it('принимает корректное правило', () => {
    expect(ruleIssuesOk(checkRule(rule()))).toBe(true)
  })

  it('не пропускает событие вне каталога', () => {
    const issues = checkRule(
      rule({ trigger: { kind: 'event', type: 'ghost.created', filter: {} } }),
    )
    expect(issues.some((issue) => issue.path === 'trigger.type')).toBe(true)
  })

  it('не пропускает выражение с неизвестным корнем', () => {
    const issues = checkRule(rule({ conditions: { expr: 'secret.value > 0' } }))
    expect(issues.find((issue) => issue.severity === 'error')?.path).toBe('conditions.0')
  })

  it('не пропускает правило без служебного пользователя', () => {
    const issues = checkRule(rule({ runAs: null }))
    expect(issues.some((issue) => issue.path === 'runAs' && issue.severity === 'error')).toBe(true)
  })

  it('не пропускает неверное расписание и пояс', () => {
    const bad = rule({
      trigger: { kind: 'schedule', cron: '99 99 * * *', timezone: 'Asia/Dushanbe', objectId: null },
    })
    expect(ruleIssuesOk(checkRule(bad))).toBe(false)
    const zone = rule({
      trigger: { kind: 'schedule', cron: '0 9 * * *', timezone: 'Нигде/Никогда', objectId: null },
    })
    expect(ruleIssuesOk(checkRule(zone))).toBe(false)
  })

  it('проверяет выражения назначений и шаблоны действий', () => {
    const badAssignee = checkRule(
      rule({
        actions: [{ type: 'notify', to: ['совсем не выражение'], text: 'Текст' }],
      }),
    )
    expect(badAssignee.some((issue) => issue.path === 'actions.0.to.0')).toBe(true)

    const badTemplate = checkRule(
      rule({ actions: [{ type: 'notify', to: [`user:${USER_ID}`], text: 'Текст {{ 1 + }}' }] }),
    )
    expect(badTemplate.some((issue) => issue.path === 'actions.0.text')).toBe(true)
  })

  it('предупреждает о правиле на весь домен без условий', () => {
    const issues = checkRule(rule({ trigger: { kind: 'event', type: 'task.*', filter: {} } }))
    expect(issues.some((issue) => issue.severity === 'warning')).toBe(true)
  })

  it('требует срок у поручения', () => {
    const issues = checkRule(
      rule({
        actions: [
          {
            type: 'create_task',
            title: 'Проверить {{object.title}}',
            assignee: `user:${USER_ID}`,
          },
        ],
      }),
    )
    expect(issues.some((issue) => issue.path.endsWith('dueWorkingDays'))).toBe(true)
  })
})
