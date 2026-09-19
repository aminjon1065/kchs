import { describe, expect, it } from 'vitest'
import {
  addStepAssignee,
  applyConditions,
  availableActions,
  cancelProcess,
  completeStep,
  decideStep,
  delegateStep,
  type InstanceState,
  type ProcessDefinition,
  ProcessError,
  previousAssignees,
  reassignStep,
  startProcess,
  validateDefinition,
} from '../src/index.js'
import { activeKeys, activeRun, define, driver, entryStates, testEnv, u } from './fixtures.js'

const A = u('a')
const B = u('b')
const C = u('c')
const D = u('d')
const AUTHOR = u('author')
const SIGNER = u('signer')

function expectValid(def: ProcessDefinition): void {
  const result = validateDefinition(def)
  expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([])
}

/**
 * Маршрут документа: параллельное согласование (A, B, C) с возвратом автору
 * и повторным согласованием только отклонивших → подпись → конец.
 */
const DOCUMENT = define({
  version: 1,
  key: 'document_route',
  objectType: 'document',
  name: { ru: 'Документ' },
  variables: {
    reviewers: { type: 'users', label: { ru: 'Согласующие' } },
    signer: { type: 'user', label: { ru: 'Подписант' } },
    x: { type: 'users', label: { ru: 'Назначенные' } },
  },
  start: 'review',
  steps: {
    review: {
      type: 'approval',
      mode: 'parallel',
      quorum: 'all',
      assignees: ['var:reviewers'],
      onReject: 'back',
      allowAddApprover: true,
      next: 'sign',
    },
    sign: { type: 'sign', assignees: ['var:signer'], onReject: 'back', next: 'end' },
    back: { type: 'return', to: 'author', reapproval: 'rejecters_only', next: 'review' },
    end: { type: 'end' },
  },
})

function documentDriver() {
  const env = testEnv()
  return {
    env,
    ...driver(DOCUMENT, env, {
      assignees: { review: [A, B, C], sign: [SIGNER], back: [AUTHOR] },
    }),
  }
}

function decide(
  def: ProcessDefinition,
  state: InstanceState,
  key: string,
  userId: string,
  decision: Parameters<typeof decideStep>[2]['decision'],
  drive: (t: ReturnType<typeof decideStep>) => InstanceState,
  env = testEnv(),
): InstanceState {
  return drive(decideStep(def, state, { stepId: activeRun(state, key).id, userId, decision }, env))
}

describe('согласование', () => {
  it('маршрут документа проходит проверку', () => {
    expectValid(DOCUMENT)
  })

  it('параллельное: все согласовали → подпись → завершение', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    expect(activeKeys(state)).toEqual(['review'])
    expect(entryStates(activeRun(state, 'review'))).toEqual({
      [A]: 'pending',
      [B]: 'pending',
      [C]: 'pending',
    })
    state = decide(DOCUMENT, state, 'review', A, 'approve', run)
    state = decide(DOCUMENT, state, 'review', B, 'approve', run)
    expect(activeKeys(state)).toEqual(['review'])
    state = decide(DOCUMENT, state, 'review', C, 'approve', run)
    expect(activeKeys(state)).toEqual(['sign'])
    state = decide(DOCUMENT, state, 'sign', SIGNER, 'sign', run)
    expect(state.status).toBe('finished')
    expect(state.outcome).toBe('completed')
    expect(state.steps.map((step) => [step.key, step.status, step.outcome])).toEqual([
      ['review', 'completed', 'approved'],
      ['sign', 'completed', 'signed'],
      ['end', 'completed', 'completed'],
    ])
  })

  it('замечания ждут ответов всех; повторно согласуют только не одобрившие', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    state = decide(DOCUMENT, state, 'review', A, 'approve', run)
    state = decide(DOCUMENT, state, 'review', B, 'remarks', run)
    // замечания не прерывают шаг: C ещё отвечает
    expect(activeKeys(state)).toEqual(['review'])
    state = decide(DOCUMENT, state, 'review', C, 'remarks', run)
    expect(activeRun(state, 'back').entries).toMatchObject([{ userId: AUTHOR, state: 'pending' }])
    const firstRound = state.steps.find((step) => step.key === 'review')
    expect(firstRound?.outcome).toBe('remarks')

    // автор загрузил новую версию и отправил повторно
    state = decide(DOCUMENT, state, 'back', AUTHOR, 'resubmit', run)
    expect(state.round).toBe(2)
    expect(state.reapproval).toBe('rejecters_only')
    const second = activeRun(state, 'review')
    expect(second.round).toBe(2)
    expect(entryStates(second)).toEqual({ [A]: 'carried', [B]: 'pending', [C]: 'pending' })

    state = decide(DOCUMENT, state, 'review', B, 'approve', run)
    state = decide(DOCUMENT, state, 'review', C, 'approve', run)
    expect(activeKeys(state)).toEqual(['sign'])
  })

  it('отклонение завершает параллельный шаг сразу: ответы остальных не нужны', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    state = decide(DOCUMENT, state, 'review', A, 'approve', run)
    state = decide(DOCUMENT, state, 'review', B, 'reject', run)
    const first = state.steps.find((step) => step.key === 'review')
    expect(first?.outcome).toBe('rejected')
    expect(first && entryStates(first)).toEqual({
      [A]: 'approved',
      [B]: 'rejected',
      [C]: 'cancelled',
    })
    expect(activeKeys(state)).toEqual(['back'])
    // во втором круге не ответивший C согласует вместе с отклонившим B
    state = decide(DOCUMENT, state, 'back', AUTHOR, 'resubmit', run)
    expect(entryStates(activeRun(state, 'review'))).toEqual({
      [A]: 'carried',
      [B]: 'pending',
      [C]: 'pending',
    })
  })

  it('полное повторное согласование: все отвечают заново', () => {
    const def = define({
      ...DOCUMENT,
      steps: { ...DOCUMENT.steps, back: { type: 'return', reapproval: 'full', next: 'review' } },
    })
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { review: [A, B], back: [AUTHOR] } })
    let state = run(startProcess(def, env))
    state = decide(def, state, 'review', A, 'approve', run)
    state = decide(def, state, 'review', B, 'reject', run)
    state = decide(def, state, 'back', AUTHOR, 'resubmit', run)
    expect(entryStates(activeRun(state, 'review'))).toEqual({ [A]: 'pending', [B]: 'pending' })
  })

  it('все одобрили в прошлом круге — шаг засчитан без Входящих', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    for (const user of [A, B, C]) state = decide(DOCUMENT, state, 'review', user, 'approve', run)
    state = decide(DOCUMENT, state, 'sign', SIGNER, 'refuse', run)
    expect(activeKeys(state)).toEqual(['back'])
    state = decide(DOCUMENT, state, 'back', AUTHOR, 'resubmit', run)
    // согласование засчитано целиком, подпись — заново
    const review = state.steps.filter((step) => step.key === 'review')
    expect(review.map((step) => step.outcome)).toEqual(['approved', 'approved'])
    expect(entryStates(review[1] as never)).toEqual({
      [A]: 'carried',
      [B]: 'carried',
      [C]: 'carried',
    })
    expect(activeKeys(state)).toEqual(['sign'])
  })

  it('отзыв после возврата завершает маршрут', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    state = decide(DOCUMENT, state, 'review', A, 'reject', run)
    state = decide(DOCUMENT, state, 'back', AUTHOR, 'withdraw', run)
    expect(state.status).toBe('cancelled')
    expect(state.outcome).toBe('withdrawn')
    expect(activeKeys(state)).toEqual([])
  })

  it('кворум any и n; режим any', () => {
    const quorum = (value: 'any' | number, mode: 'parallel' | 'any' = 'parallel') =>
      define({
        version: 1,
        key: 'quorum_route',
        objectType: 'document',
        name: { ru: 'Кворум' },
        start: 'vote',
        steps: {
          vote: { type: 'approval', mode, quorum: value, assignees: ['var:x'], next: 'end' },
          end: { type: 'end' },
        },
      })
    const env = testEnv()

    const any = quorum('any')
    const r1 = driver(any, env, { assignees: { vote: [A, B, C] } })
    let state = r1.run(startProcess(any, env))
    state = decide(any, state, 'vote', A, 'reject', r1.run)
    // отклонение не мешает: кворум ещё достижим
    expect(activeKeys(state)).toEqual(['vote'])
    state = decide(any, state, 'vote', B, 'approve', r1.run)
    expect(state.status).toBe('finished')
    expect(entryStates(state.steps[0] as never)).toEqual({
      [A]: 'rejected',
      [B]: 'approved',
      [C]: 'cancelled',
    })

    const two = quorum(2)
    const r2 = driver(two, env, { assignees: { vote: [A, B, C] } })
    state = r2.run(startProcess(two, env))
    state = decide(two, state, 'vote', A, 'approve', r2.run)
    state = decide(two, state, 'vote', B, 'remarks', r2.run)
    expect(activeKeys(state)).toEqual(['vote'])
    state = decide(two, state, 'vote', C, 'reject', r2.run)
    // одобрений 1 из нужных 2, отвечать больше некому
    expect(state.status).toBe('finished')
    expect(state.outcome).toBe('rejected')
    expect(state.steps[0]?.outcome).toBe('rejected')

    const first = quorum('any', 'any')
    const r3 = driver(first, env, { assignees: { vote: [A, B] } })
    state = r3.run(startProcess(first, env))
    state = decide(first, state, 'vote', B, 'remarks', r3.run)
    expect(state.steps[0]?.outcome).toBe('remarks')
    expect(entryStates(state.steps[0] as never)).toEqual({ [A]: 'cancelled', [B]: 'remarks' })
  })

  it('последовательное: очередь по порядку, отклонение прерывает очередь', () => {
    const def = define({
      version: 1,
      key: 'seq',
      objectType: 'document',
      name: { ru: 'По очереди' },
      start: 'chain',
      steps: {
        chain: {
          type: 'approval',
          mode: 'sequential',
          assignees: ['var:x'],
          onReject: 'end:returned',
          next: 'end',
        },
        end: { type: 'end' },
      },
    })
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { chain: [A, B, C] } })
    let state = run(startProcess(def, env))
    expect(entryStates(activeRun(state, 'chain'))).toEqual({
      [A]: 'pending',
      [B]: 'waiting',
      [C]: 'waiting',
    })
    expect(() =>
      decideStep(
        def,
        state,
        { stepId: activeRun(state, 'chain').id, userId: B, decision: 'approve' },
        env,
      ),
    ).toThrowError(new ProcessError('not_your_turn', 'Очередь согласования ещё не дошла до вас'))
    state = decide(def, state, 'chain', A, 'approve', run)
    expect(entryStates(activeRun(state, 'chain'))).toEqual({
      [A]: 'approved',
      [B]: 'pending',
      [C]: 'waiting',
    })
    state = decide(def, state, 'chain', B, 'reject', run)
    expect(state.status).toBe('finished')
    expect(state.outcome).toBe('returned')
    expect(entryStates(state.steps[0] as never)).toEqual({
      [A]: 'approved',
      [B]: 'rejected',
      [C]: 'cancelled',
    })
  })

  it('решение: чужой шаг, повтор, недоступное решение', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    const stepId = activeRun(state, 'review').id
    expect(() =>
      decideStep(DOCUMENT, state, { stepId, userId: D, decision: 'approve' }, env),
    ).toThrowError('Вы не назначены на этот шаг')
    expect(() =>
      decideStep(DOCUMENT, state, { stepId, userId: A, decision: 'sign' }, env),
    ).toThrowError('Это решение для шага недоступно')
    state = decide(DOCUMENT, state, 'review', A, 'approve', run)
    expect(() =>
      decideStep(DOCUMENT, state, { stepId, userId: A, decision: 'approve' }, env),
    ).toThrowError('Решение уже принято')
  })
})

describe('параллельные ветви', () => {
  /**
   * fork: ветвь 0 — legal, затем вложенная группа inner (it | security, join any);
   * ветвь 1 — finance. Отклонение юриста возвращает автору.
   */
  const NESTED = define({
    version: 1,
    key: 'nested',
    objectType: 'document',
    name: { ru: 'Вложенные группы' },
    start: 'fork',
    steps: {
      fork: { type: 'parallel', branches: [['legal', 'inner'], ['finance']], next: 'sign' },
      legal: { type: 'approval', assignees: ['var:x'], onReject: 'back' },
      inner: { type: 'parallel', branches: [['it'], ['security']], join: 'any' },
      it: { type: 'approval', assignees: ['var:x'] },
      security: { type: 'approval', assignees: ['var:x'] },
      finance: { type: 'approval', assignees: ['var:x'] },
      sign: { type: 'sign', assignees: ['var:x'], next: 'end' },
      back: { type: 'return', reapproval: 'rejecters_only', next: 'fork' },
      end: { type: 'end' },
    },
  })
  const ASSIGNEES = {
    legal: [A],
    it: [B],
    security: [C],
    finance: [D],
    sign: [SIGNER],
    back: [AUTHOR],
  }

  it('проходит проверку', () => {
    expectValid(NESTED)
  })

  it('ветви идут по порядку, группа any закрывается первой ветвью, join all ждёт все', () => {
    const env = testEnv()
    const { run } = driver(NESTED, env, { assignees: ASSIGNEES })
    let state = run(startProcess(NESTED, env))
    expect(activeKeys(state)).toEqual(['fork', 'legal', 'finance'])
    state = decide(NESTED, state, 'legal', A, 'approve', run)
    expect(activeKeys(state)).toEqual(['fork', 'finance', 'inner', 'it', 'security'])
    state = decide(NESTED, state, 'security', C, 'approve', run)
    // join any: вторая ветвь вложенной группы больше не нужна
    expect(activeKeys(state)).toEqual(['fork', 'finance'])
    expect(state.steps.find((step) => step.key === 'it')?.status).toBe('cancelled')
    expect(state.steps.find((step) => step.key === 'inner')?.outcome).toBe('completed')
    state = decide(NESTED, state, 'finance', D, 'approve', run)
    expect(activeKeys(state)).toEqual(['sign'])
    // предыдущий шаг подписи — группа: назначенные всех ветвей
    expect(previousAssignees(state, activeRun(state, 'sign').id).sort()).toEqual(
      [A, B, C, D].sort(),
    )
  })

  it('отклонение в ветви снимает соседние ветви; второй круг засчитывает одобривших', () => {
    const env = testEnv()
    const { run } = driver(NESTED, env, { assignees: ASSIGNEES })
    let state = run(startProcess(NESTED, env))
    state = decide(NESTED, state, 'finance', D, 'approve', run)
    state = decide(NESTED, state, 'legal', A, 'remarks', run)
    expect(activeKeys(state)).toEqual(['back'])
    expect(state.steps.find((step) => step.key === 'fork')?.status).toBe('cancelled')
    state = decide(NESTED, state, 'back', AUTHOR, 'resubmit', run)
    // finance одобрен в прошлом круге — засчитан сразу, ветвь финансиста завершена
    expect(activeKeys(state)).toEqual(['fork', 'legal'])
    state = decide(NESTED, state, 'legal', A, 'approve', run)
    state = decide(NESTED, state, 'it', B, 'approve', run)
    expect(activeKeys(state)).toEqual(['sign'])
  })
})

describe('условия', () => {
  it('шаг condition: ветвь по итогу прошлого шага и данным', () => {
    const def = define({
      version: 1,
      key: 'cond',
      objectType: 'document',
      name: { ru: 'Условие' },
      start: 'first',
      steps: {
        first: {
          type: 'approval',
          mode: 'any',
          assignees: ['var:x'],
          onReject: 'continue',
          next: 'route',
        },
        route: {
          type: 'condition',
          branches: [
            { if: "steps.first.outcome = 'remarks'", next: 'fix' },
            { if: 'object.fields.amount > 1000000', next: 'big' },
          ],
          else: 'end',
        },
        fix: { type: 'notify', to: 'author', next: 'end' },
        big: { type: 'approval', assignees: ['var:x'], next: 'end' },
        end: { type: 'end' },
      },
    })
    expectValid(def)
    const run = (amount: number, decision: 'approve' | 'remarks') => {
      const env = testEnv({ object: { fields: { amount } } })
      const { run: drive } = driver(def, env, {
        assignees: { first: [A], fix: [AUTHOR], big: [B] },
      })
      const state = drive(startProcess(def, env))
      return decide(def, state, 'first', A, decision, drive, env)
    }
    expect(run(5, 'remarks').steps.map((step) => step.key)).toEqual([
      'first',
      'route',
      'fix',
      'end',
    ])
    expect(activeKeys(run(2_000_000, 'approve'))).toEqual(['big'])
    const plain = run(5, 'approve')
    expect(plain.status).toBe('finished')
    expect(plain.steps.find((step) => step.key === 'route')?.outcome).toBe('else')
  })

  it('условие запуска вставляет шаг финансиста перед заместителем', () => {
    const base = define({
      version: 1,
      key: 'insert',
      objectType: 'document',
      name: { ru: 'Вставка' },
      start: 'legal',
      steps: {
        legal: { type: 'approval', assignees: ['var:x'], next: 'deputy' },
        deputy: { type: 'approval', assignees: ['var:x'], next: 'end' },
        end: { type: 'end' },
      },
      conditions: [
        {
          if: 'object.fields.amount > 1000000',
          insertBefore: 'deputy',
          step: { type: 'approval', assignees: ['role_in_space:finance'] },
        },
      ],
    })
    const def = applyConditions(base, [0])
    expectValid(def)
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { legal: [A], cond_1: [B], deputy: [C] } })
    let state = run(startProcess(def, env))
    state = decide(def, state, 'legal', A, 'approve', run)
    expect(activeKeys(state)).toEqual(['cond_1'])
    state = decide(def, state, 'cond_1', B, 'approve', run)
    expect(activeKeys(state)).toEqual(['deputy'])
  })
})

describe('автоматические шаги, ожидание, ознакомление, регистрация', () => {
  const AUTO = define({
    version: 1,
    key: 'auto',
    objectType: 'document',
    name: { ru: 'Автоматические шаги' },
    start: 'tell',
    steps: {
      tell: { type: 'notify', to: ['author', 'var:x'], next: 'mark' },
      mark: { type: 'set', field: 'status', value: 'on_review', next: 'hold' },
      hold: { type: 'wait', event: 'document.version_added', next: 'send' },
      send: { type: 'call', action: 'documents.dispatch', next: 'job' },
      job: { type: 'task', title: { ru: 'Отправить' }, assignees: ['var:x'], next: 'ack' },
      ack: { type: 'acknowledge', assignees: ['var:x'], next: 'reg' },
      reg: { type: 'register', assignees: ['role:registrar'], journal: 'out', next: 'end' },
      end: { type: 'end', outcome: 'registered' },
    },
  })

  it('уведомление и поле — сразу, ожидание и поручение — до сигнала', () => {
    expectValid(AUTO)
    const env = testEnv()
    const { run } = driver(AUTO, env, {
      assignees: { tell: [AUTHOR, A], job: [B], ack: [A, B], reg: [C] },
      waitFor: ['job'],
    })
    let state = run(startProcess(AUTO, env))
    expect(activeKeys(state)).toEqual(['hold'])
    expect(
      state.steps.find((step) => step.key === 'tell')?.entries.map((item) => item.state),
    ).toEqual(['notified', 'notified'])
    state = run(
      completeStep(AUTO, state, { stepId: activeRun(state, 'hold').id, outcome: 'event' }, env),
    )
    expect(activeKeys(state)).toEqual(['job'])
    expect(activeRun(state, 'job').entries).toMatchObject([{ userId: B, state: 'assigned' }])
    // поручение исполнено — модуль сообщает о завершении шага
    state = run(
      completeStep(
        AUTO,
        state,
        { stepId: activeRun(state, 'job').id, result: { taskId: 't-1' } },
        env,
      ),
    )
    expect(activeKeys(state)).toEqual(['ack'])
    state = decide(AUTO, state, 'ack', A, 'acknowledge', run)
    expect(activeKeys(state)).toEqual(['ack'])
    state = decide(AUTO, state, 'ack', B, 'acknowledge', run)
    expect(activeKeys(state)).toEqual(['reg'])
    state = run(
      decideStep(
        AUTO,
        state,
        {
          stepId: activeRun(state, 'reg').id,
          userId: C,
          decision: 'register',
          result: { number: 'ИСХ-1/26' },
        },
        env,
      ),
    )
    expect(state.status).toBe('finished')
    expect(state.outcome).toBe('registered')
    expect(state.steps.find((step) => step.key === 'reg')?.result).toEqual({ number: 'ИСХ-1/26' })
  })

  it('решение для автоматического шага и завершение шага решения — ошибка', () => {
    const env = testEnv()
    const { run } = driver(AUTO, env, { assignees: { tell: [A] } })
    const state = run(startProcess(AUTO, env))
    const hold = activeRun(state, 'hold')
    expect(() =>
      decideStep(AUTO, state, { stepId: hold.id, userId: A, decision: 'approve' }, env),
    ).toThrowError('Это решение для шага недоступно')
    const review = define({
      version: 1,
      key: 'review_only',
      objectType: 'document',
      name: { ru: 'r' },
      start: 'a',
      steps: { a: { type: 'approval', assignees: ['author'], next: 'end' }, end: { type: 'end' } },
    })
    const reviewState = driver(review, env, { assignees: { a: [A] } }).run(
      startProcess(review, env),
    )
    expect(() =>
      completeStep(review, reviewState, { stepId: activeRun(reviewState, 'a').id }, env),
    ).toThrowError('Шаг завершается решением назначенных')
  })

  it('ознакомить некого — шаг выполнен; решить некому — ждёт переназначения', () => {
    const def = define({
      version: 1,
      key: 'empty',
      objectType: 'document',
      name: { ru: 'Пусто' },
      start: 'ack',
      steps: {
        ack: { type: 'acknowledge', assignees: ['var:x'], next: 'review' },
        review: { type: 'approval', mode: 'sequential', assignees: ['var:x'], next: 'end' },
        end: { type: 'end' },
      },
    })
    const env = testEnv()
    let state = driver(def, env).run(startProcess(def, env))
    expect(state.steps[0]?.outcome).toBe('acknowledged')
    const review = activeRun(state, 'review')
    expect(review.resolved).toBe(true)
    expect(review.entries).toEqual([])
    const { run } = driver(def, env)
    state = run(
      reassignStep(def, state, { stepId: review.id, fromUserId: null, userIds: [A, B] }, env),
    )
    expect(entryStates(activeRun(state, 'review'))).toEqual({ [A]: 'pending', [B]: 'waiting' })
  })
})

describe('состав назначенных', () => {
  it('добавить согласующего: параллельно — сразу, последовательно — после себя', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    const review = activeRun(state, 'review')
    state = run(
      addStepAssignee(DOCUMENT, state, { stepId: review.id, byUserId: A, userId: D }, env),
    )
    expect(entryStates(activeRun(state, 'review'))[D]).toBe('pending')
    expect(activeRun(state, 'review').entries.find((item) => item.userId === D)?.addedBy).toBe(A)
    expect(() =>
      addStepAssignee(DOCUMENT, state, { stepId: review.id, byUserId: A, userId: B }, env),
    ).toThrowError('Сотрудник уже участвует в этом шаге')

    // добавленный согласующий остаётся во втором круге
    for (const user of [A, B, C]) state = decide(DOCUMENT, state, 'review', user, 'approve', run)
    state = decide(DOCUMENT, state, 'review', D, 'remarks', run)
    state = decide(DOCUMENT, state, 'back', AUTHOR, 'resubmit', run)
    expect(entryStates(activeRun(state, 'review'))).toEqual({
      [A]: 'carried',
      [B]: 'carried',
      [C]: 'carried',
      [D]: 'pending',
    })

    const sequential = define({
      ...DOCUMENT,
      steps: {
        ...DOCUMENT.steps,
        review: { ...DOCUMENT.steps.review, mode: 'sequential' } as never,
      },
    })
    const seq = driver(sequential, env, { assignees: { review: [A, B] } })
    let queue = seq.run(startProcess(sequential, env))
    queue = seq.run(
      addStepAssignee(
        sequential,
        queue,
        { stepId: activeRun(queue, 'review').id, byUserId: A, userId: D },
        env,
      ),
    )
    expect(activeRun(queue, 'review').entries.map((item) => [item.userId, item.state])).toEqual([
      [A, 'pending'],
      [D, 'waiting'],
      [B, 'waiting'],
    ])
  })

  it('делегирование шага: решает получивший, одобрение засчитывается передавшему', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    const review = activeRun(state, 'review')
    state = run(
      delegateStep(DOCUMENT, state, { stepId: review.id, fromUserId: B, toUserId: D }, env),
    )
    expect(activeRun(state, 'review').entries.map((item) => [item.userId, item.state])).toEqual([
      [A, 'pending'],
      [B, 'delegated'],
      [D, 'pending'],
      [C, 'pending'],
    ])
    state = decide(DOCUMENT, state, 'review', D, 'approve', run)
    state = decide(DOCUMENT, state, 'review', A, 'approve', run)
    state = decide(DOCUMENT, state, 'review', C, 'reject', run)
    state = decide(DOCUMENT, state, 'back', AUTHOR, 'resubmit', run)
    expect(entryStates(activeRun(state, 'review'))).toEqual({
      [A]: 'carried',
      [B]: 'carried',
      [C]: 'pending',
    })
  })

  it('действия пользователя: свои и замещаемого, подпись с подтверждением', () => {
    const def = define({
      ...DOCUMENT,
      steps: { ...DOCUMENT.steps, sign: { ...DOCUMENT.steps.sign, requireMfa: true } as never },
    })
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { review: [A, B, C], sign: [SIGNER] } })
    let state = run(startProcess(def, env))
    expect(availableActions(def, state, { userId: D, actingFor: [B] })).toEqual([
      {
        stepId: activeRun(state, 'review').id,
        stepKey: 'review',
        type: 'approval',
        onBehalfOf: B,
        actions: ['approve', 'remarks', 'reject', 'delegate', 'add_approver'],
        requireMfa: false,
      },
    ])
    for (const user of [A, B, C]) state = decide(def, state, 'review', user, 'approve', run)
    expect(availableActions(def, state, { userId: SIGNER, actingFor: [] })).toMatchObject([
      { stepKey: 'sign', actions: ['sign', 'refuse'], requireMfa: true },
    ])
    expect(availableActions(def, state, { userId: A, actingFor: [] })).toEqual([])
  })

  it('решение заместителя сохраняет, кто действовал', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    state = run(
      decideStep(
        DOCUMENT,
        state,
        { stepId: activeRun(state, 'review').id, userId: A, actorId: D, decision: 'approve' },
        env,
      ),
    )
    expect(activeRun(state, 'review').entries[0]).toMatchObject({
      userId: A,
      state: 'approved',
      actorId: D,
    })
  })

  it('отмена маршрута закрывает активные шаги', () => {
    const { env, run } = documentDriver()
    let state = run(startProcess(DOCUMENT, env))
    state = cancelProcess(DOCUMENT, state, {}, env).state
    expect(state.status).toBe('cancelled')
    expect(state.steps[0]?.status).toBe('cancelled')
    expect(Object.values(entryStates(state.steps[0] as never))).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ])
    expect(() => cancelProcess(DOCUMENT, state, {}, env)).toThrowError('Маршрут уже завершён')
  })
})
