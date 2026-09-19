import { describe, expect, it } from 'vitest'
import {
  applyConditions,
  ProcessDefinition,
  stepAssigneeExpressions,
  validateDefinition,
} from '../src/index.js'
import { CONTRACT_EXAMPLE } from './fixtures.js'

describe('схема ProcessDefinition', () => {
  it('пример контракта проходит схему и проверку без ошибок', () => {
    const result = validateDefinition(CONTRACT_EXAMPLE)
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('значения по умолчанию: режим, кворум, передача шага, возврат автору', () => {
    const def = ProcessDefinition.parse(CONTRACT_EXAMPLE)
    const deputy = def.steps.deputy_review
    expect(deputy).toMatchObject({ quorum: 'all', allowAddApprover: false, allowDelegate: true })
    expect(def.steps.sign).toMatchObject({ mode: 'parallel', signatureKind: 'simple' })
    expect(def.steps.return_to_author).toMatchObject({ to: 'author', reapproval: 'rejecters_only' })
    expect(def.steps.dispatch).toMatchObject({ params: {} })
    expect(def.conditions[0]).toMatchObject({ at: 'start' })
  })

  it('все типы шагов контракта', () => {
    const def = ProcessDefinition.parse({
      version: 1,
      key: 'all_types',
      objectType: 'document',
      name: { ru: 'Все шаги' },
      start: 'choose',
      steps: {
        choose: {
          type: 'condition',
          branches: [{ if: "object.fields.kind = 'urgent'", next: 'fork' }],
          else: 'fork',
        },
        fork: { type: 'parallel', branches: [['a1', 'a2'], ['ack']], join: 'any', next: 'hold' },
        a1: { type: 'approval', assignees: ['author'] },
        a2: { type: 'sign', assignees: ['author'] },
        ack: { type: 'acknowledge', assignees: ['unit:11111111-1111-4111-8111-111111111111'] },
        hold: { type: 'wait', event: 'object.updated', filter: 'event.type = 1', next: 'tell' },
        tell: { type: 'notify', to: 'author', template: 'routeDone', next: 'mark' },
        mark: { type: 'set', field: 'status', value: 'approved', next: 'send' },
        send: {
          type: 'call',
          action: 'documents.dispatch',
          params: { channel: 'mail' },
          next: 'reg',
        },
        reg: { type: 'register', next: 'job' },
        job: { type: 'task', title: { ru: 'Поручение' }, assignees: ['author'], next: 'end' },
        back: { type: 'return', next: 'choose' },
        end: { type: 'end' },
      },
    })
    expect(Object.values(def.steps).map((step) => step.type)).toEqual([
      'condition',
      'parallel',
      'approval',
      'sign',
      'acknowledge',
      'wait',
      'notify',
      'set',
      'call',
      'register',
      'task',
      'return',
      'end',
    ])
    expect(stepAssigneeExpressions(def.steps.back as never)).toEqual(['author'])
    expect(stepAssigneeExpressions(def.steps.tell as never)).toEqual(['author'])
    expect(stepAssigneeExpressions(def.steps.reg as never)).toEqual([])
  })

  it.each([
    ['неизвестный ключ шага', { typo: 1 }],
    ['кворум ноль', { quorum: 0 }],
    ['пустой список назначенных', { assignees: [] }],
    ['срок меньше нуля', { dueWorkingDays: -1 }],
    ['неизвестный режим', { mode: 'random' }],
    ['onReject с пробелом', { onReject: 'end: x' }],
  ])('схема отклоняет: %s', (_, patch) => {
    const input = structuredClone(CONTRACT_EXAMPLE) as Record<string, unknown>
    const steps = input.steps as Record<string, Record<string, unknown>>
    steps.legal_review = { ...steps.legal_review, ...patch }
    expect(ProcessDefinition.safeParse(input).success).toBe(false)
  })

  it('версия формата — только 1; ключ шага — латиница', () => {
    expect(ProcessDefinition.safeParse({ ...CONTRACT_EXAMPLE, version: 2 }).success).toBe(false)
    const input = structuredClone(CONTRACT_EXAMPLE) as Record<string, unknown>
    const cyrillic = 'Шаг'
    ;(input.steps as Record<string, unknown>)[cyrillic] = { type: 'end' }
    expect(ProcessDefinition.safeParse(input).success).toBe(false)
  })
})

describe('условия запуска', () => {
  it('вставленный шаг встаёт перед insertBefore на всех путях', () => {
    const def = ProcessDefinition.parse(CONTRACT_EXAMPLE)
    const effective = applyConditions(def, [0])
    expect(effective.steps.legal_review).toMatchObject({ next: 'cond_1' })
    expect(effective.steps.cond_1).toMatchObject({
      type: 'approval',
      assignees: ['role_in_space:finance'],
      next: 'deputy_review',
    })
    expect(effective.conditions).toEqual([])
    expect(applyConditions(def, [])).toEqual({ ...def, conditions: [] })
  })

  it('две вставки перед одним шагом — в порядке условий; вставка перед началом меняет start', () => {
    const def = ProcessDefinition.parse({
      ...CONTRACT_EXAMPLE,
      conditions: [
        {
          if: 'true',
          insertBefore: 'legal_review',
          key: 'first',
          step: { type: 'notify', to: 'author' },
        },
        {
          if: 'true',
          insertBefore: 'legal_review',
          key: 'second',
          step: { type: 'acknowledge', assignees: ['author'] },
        },
      ],
    })
    const effective = applyConditions(def, [1, 0])
    expect(effective.start).toBe('first')
    expect(effective.steps.first).toMatchObject({ next: 'second' })
    expect(effective.steps.second).toMatchObject({ next: 'legal_review' })
    // возврат ведёт на первый вставленный шаг
    expect(effective.steps.return_to_author).toMatchObject({ next: 'first' })
  })
})
