import { describe, expect, it } from 'vitest'
import {
  addBranch,
  blankDefinition,
  type Definition,
  insertAfter,
  insertIntoBranch,
  issuesByStep,
  issueTarget,
  layoutOf,
  moveStep,
  removeBranch,
  removeStep,
  renameStep,
} from './model.js'

/** Маршрут исходящего письма из контракта (docs/contracts/process-definition.md). */
function outgoing(): Definition {
  return {
    version: 1,
    key: 'outgoing_letter_default',
    objectType: 'document',
    name: { ru: 'Исходящее письмо' },
    variables: {},
    start: 'review',
    steps: {
      review: {
        type: 'parallel',
        branches: [['legal'], ['dept']],
        join: 'all',
        next: 'deputy',
      },
      legal: {
        type: 'approval',
        mode: 'parallel',
        quorum: 'all',
        assignees: ['role_in_space:legal'],
        allowAddApprover: false,
        allowDelegate: true,
        onReject: 'back',
      },
      dept: {
        type: 'approval',
        mode: 'parallel',
        quorum: 'all',
        assignees: ['unit_head(author.unit)'],
        allowAddApprover: false,
        allowDelegate: true,
      },
      deputy: {
        type: 'approval',
        mode: 'sequential',
        quorum: 'all',
        assignees: ['manager(unit_head(author.unit))'],
        allowAddApprover: false,
        allowDelegate: true,
        onReject: 'back',
        next: 'sign',
      },
      sign: {
        type: 'sign',
        mode: 'parallel',
        assignees: ['var:signer'],
        requireMfa: true,
        signatureKind: 'simple',
        next: 'register',
      },
      register: { type: 'register', journal: 'outgoing', next: 'end' },
      back: { type: 'return', to: 'author', reapproval: 'rejecters_only', next: 'review' },
      orphan: { type: 'notify', to: 'author', next: 'end' },
      end: { type: 'end', outcome: 'completed' },
    },
    timers: [{ step: 'deputy', onOverdue: [{ action: 'notify', to: 'manager(step.assignee)' }] }],
    conditions: [
      {
        at: 'start',
        if: 'object.fields.amount > 1000000',
        insertBefore: 'deputy',
        step: {
          type: 'approval',
          mode: 'parallel',
          quorum: 'all',
          assignees: ['role_in_space:finance'],
          allowAddApprover: false,
          allowDelegate: true,
        },
      },
    ],
  }
}

const keys = (nodes: Array<{ key: string }>) => nodes.map((node) => node.key)

describe('раскладка маршрута', () => {
  it('основная линия, ветви группы, возврат и недостижимый шаг', () => {
    const layout = layoutOf(outgoing())
    expect(keys(layout.main.nodes)).toEqual(['review', 'deputy', 'sign', 'register', 'end'])
    expect(layout.main.nodes[0]?.branches?.map(keys)).toEqual([['legal'], ['dept']])
    expect(layout.owners.get('dept')).toEqual({ parallel: 'review', branch: 1 })
    expect(layout.others.map((chain) => keys(chain.nodes))).toEqual([['back'], ['orphan']])
    // Возврат ведёт обратно к началу; сюда приходят отклонения
    expect(layout.others[0]?.continuesTo).toBe('review')
    expect(layout.others[0]?.enteredFrom).toEqual(
      expect.arrayContaining([
        { key: 'legal', via: 'onReject' },
        { key: 'deputy', via: 'onReject' },
      ]),
    )
    expect(layout.others[1]?.enteredFrom).toEqual([])
  })
})

describe('правка маршрута', () => {
  it('вставка после шага и в начало сшивает переходы', () => {
    const { definition, key } = insertAfter(outgoing(), 'deputy', 'acknowledge')
    expect(key).toBe('acknowledge_1')
    expect(definition.steps.deputy).toMatchObject({ next: 'acknowledge_1' })
    expect(definition.steps.acknowledge_1).toMatchObject({ type: 'acknowledge', next: 'sign' })

    const first = insertAfter(outgoing(), null, 'notify')
    expect(first.definition.start).toBe('notify_1')
    expect(first.definition.steps.notify_1).toMatchObject({ next: 'review' })
    // После завершения и условия вставлять нельзя
    expect(insertAfter(outgoing(), 'end', 'approval').key).toBe('')
  })

  it('параллельная группа — с двумя ветвями согласования без next', () => {
    const { definition, key } = insertAfter(
      blankDefinition({
        key: 'x',
        objectType: 'document',
        name: { ru: 'X' },
      }),
      'approval_1',
      'parallel',
    )
    const group = definition.steps[key]
    expect(group?.type).toBe('parallel')
    const members = group?.type === 'parallel' ? group.branches.flat() : []
    expect(members).toEqual(['approval_2', 'approval_3'])
    for (const member of members) expect(definition.steps[member]).not.toHaveProperty('next')
    expect(group).toMatchObject({ next: 'end' })
    expect(definition.steps.approval_1).toMatchObject({ next: key })
  })

  it('шаг в ветвь — на позицию; условие и завершение в ветвь не ставятся', () => {
    const { definition, key } = insertIntoBranch(outgoing(), 'review', 1, 0, 'notify')
    expect(definition.steps.review).toMatchObject({ branches: [['legal'], [key, 'dept']] })
    expect(definition.steps[key]).not.toHaveProperty('next')
    expect(insertIntoBranch(outgoing(), 'review', 0, 1, 'condition').key).toBe('')
    expect(insertIntoBranch(outgoing(), 'review', 0, 1, 'end').key).toBe('')

    const more = addBranch(outgoing(), 'review')
    expect(more.steps.review).toMatchObject({ branches: [['legal'], ['dept'], ['approval_1']] })
    const fewer = removeBranch(more, 'review', 0)
    expect(fewer.steps.review).toMatchObject({ branches: [['dept'], ['approval_1']] })
    expect(fewer.steps.legal).toBeUndefined()
  })

  it('удаление сшивает next и начало, сбрасывает отклонение, снимает таймер', () => {
    const withoutDeputy = removeStep(outgoing(), 'deputy')
    expect(withoutDeputy.steps.review).toMatchObject({ next: 'sign' })
    expect(withoutDeputy.timers).toEqual([])
    expect(withoutDeputy.conditions[0]?.insertBefore).toBe('sign')

    const withoutBack = removeStep(outgoing(), 'back')
    expect(withoutBack.steps.legal).not.toHaveProperty('onReject')
    expect(withoutBack.steps.deputy).not.toHaveProperty('onReject')

    const withoutReview = removeStep(outgoing(), 'review')
    expect(withoutReview.start).toBe('deputy')
    expect(withoutReview.steps.legal).toBeUndefined()
    expect(withoutReview.steps.dept).toBeUndefined()
  })

  it('удаление последнего шага ветвей удаляет группу', () => {
    const single = removeBranch(outgoing(), 'review', 0)
    const empty = removeStep(single, 'dept')
    expect(empty.steps.review).toBeUndefined()
    expect(empty.start).toBe('deputy')
  })

  it('перемещение в линии пересшивает next; завершение остаётся последним', () => {
    const moved = moveStep(outgoing(), 'sign', -1)
    expect(keys(layoutOf(moved).main.nodes)).toEqual([
      'review',
      'sign',
      'deputy',
      'register',
      'end',
    ])
    expect(moved.steps.register).toMatchObject({ next: 'end' })
    const top = moveStep(outgoing(), 'deputy', -1)
    expect(top.start).toBe('deputy')
    expect(top.steps.deputy).toMatchObject({ next: 'review' })
    expect(top.steps.review).toMatchObject({ next: 'sign' })
    expect(moveStep(outgoing(), 'register', 1)).toEqual(outgoing())

    const inBranch = moveStep(
      insertIntoBranch(outgoing(), 'review', 0, 1, 'notify').definition,
      'notify_1',
      -1,
    )
    expect(inBranch.steps.review).toMatchObject({ branches: [['notify_1', 'legal'], ['dept']] })
  })

  it('переименование ключа меняет все ссылки; занятый ключ не принимается', () => {
    const renamed = renameStep(outgoing(), 'back', 'rework')
    expect(renamed.steps.rework).toMatchObject({ type: 'return' })
    expect(renamed.steps.legal).toMatchObject({ onReject: 'rework' })
    expect(renamed.steps.deputy).toMatchObject({ onReject: 'rework' })

    const group = renameStep(outgoing(), 'legal', 'lawyer')
    expect(group.steps.review).toMatchObject({ branches: [['lawyer'], ['dept']] })
    const deputy = renameStep(outgoing(), 'deputy', 'deputy_head')
    expect(deputy.timers[0]?.step).toBe('deputy_head')
    expect(deputy.conditions[0]?.insertBefore).toBe('deputy_head')
    expect(deputy.steps.review).toMatchObject({ next: 'deputy_head' })
    const start = renameStep(outgoing(), 'review', 'approvals')
    expect(start.start).toBe('approvals')

    expect(renameStep(outgoing(), 'back', 'sign')).toEqual(outgoing())
    expect(renameStep(outgoing(), 'back', 'Bad Key')).toEqual(outgoing())
  })
})

describe('проблемы проверки', () => {
  it('относятся к шагу или разделу настроек маршрута', () => {
    expect(issueTarget({ path: 'steps.legal.assignees.0' })).toEqual({ kind: 'step', key: 'legal' })
    expect(issueTarget({ path: 'timers.0.step' })).toEqual({ kind: 'route', section: 'timers' })
    expect(issueTarget({ path: 'conditions.0.step.assignees.0' })).toEqual({
      kind: 'route',
      section: 'conditions',
    })
    expect(issueTarget({ path: 'steps' })).toEqual({ kind: 'route', section: 'general' })
    const grouped = issuesByStep([
      {
        path: 'steps.legal.assignees.0',
        code: 'assignee_invalid',
        message: 'x',
        severity: 'error',
      },
      { path: 'steps.legal', code: 'unreachable', message: 'y', severity: 'error' },
      { path: 'start', code: 'unknown_step', message: 'z', severity: 'error' },
    ])
    expect(grouped.get('legal')).toHaveLength(2)
    expect(grouped.size).toBe(1)
  })
})
