import { describe, expect, it } from 'vitest'
import {
  decideStep,
  previousAssignees,
  reassignStep,
  startProcess,
  stepsScope,
  validateDefinition,
} from '../src/index.js'
import { activeKeys, activeRun, define, driver, entryStates, testEnv, u } from './fixtures.js'

const A = u('a')
const B = u('b')
const C = u('c')
const D = u('d')

function route(steps: Record<string, unknown>, start = Object.keys(steps)[0] as string) {
  const def = define({
    version: 1,
    key: 'edge_route',
    objectType: 'document',
    name: { ru: 'Граничные случаи' },
    start,
    steps: steps as never,
  })
  expect(validateDefinition(def).issues.filter((issue) => issue.severity === 'error')).toEqual([])
  return def
}

describe('граничные случаи переходов', () => {
  it('подпись: отказ одного из подписантов завершает шаг сразу; очередь подписи', () => {
    const def = route({
      sign: { type: 'sign', assignees: ['var:x'], onReject: 'end:refused', next: 'queue' },
      queue: { type: 'sign', mode: 'sequential', assignees: ['var:x'], next: 'end' },
      end: { type: 'end' },
    })
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { sign: [A, B, C], queue: [A, B] } })
    let state = run(startProcess(def, env))
    state = run(
      decideStep(
        def,
        state,
        { stepId: activeRun(state, 'sign').id, userId: A, decision: 'sign' },
        env,
      ),
    )
    state = run(
      decideStep(
        def,
        state,
        { stepId: activeRun(state, 'sign').id, userId: B, decision: 'refuse' },
        env,
      ),
    )
    expect(state.status).toBe('finished')
    expect(state.outcome).toBe('refused')
    expect(entryStates(state.steps[0] as never)).toEqual({
      [A]: 'signed',
      [B]: 'refused',
      [C]: 'cancelled',
    })

    const signing = route({
      queue: { type: 'sign', mode: 'sequential', assignees: ['var:x'], next: 'end' },
      end: { type: 'end' },
    })
    const second = driver(signing, env, { assignees: { queue: [A, B] } })
    let queue = second.run(startProcess(signing, env))
    expect(entryStates(activeRun(queue, 'queue'))).toEqual({ [A]: 'pending', [B]: 'waiting' })
    queue = second.run(
      decideStep(
        signing,
        queue,
        { stepId: activeRun(queue, 'queue').id, userId: A, decision: 'sign' },
        env,
      ),
    )
    expect(entryStates(activeRun(queue, 'queue'))).toEqual({ [A]: 'signed', [B]: 'pending' })
    queue = second.run(
      decideStep(
        signing,
        queue,
        { stepId: activeRun(queue, 'queue').id, userId: B, decision: 'sign' },
        env,
      ),
    )
    expect(queue.status).toBe('finished')
  })

  it('последовательное с кворумом 2 из 3: отклонение не прерывает, пока кворум достижим', () => {
    const def = route({
      chain: { type: 'approval', mode: 'sequential', quorum: 2, assignees: ['var:x'], next: 'end' },
      end: { type: 'end' },
    })
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { chain: [A, B, C] } })
    let state = run(startProcess(def, env))
    const step = () => activeRun(state, 'chain').id
    state = run(decideStep(def, state, { stepId: step(), userId: A, decision: 'reject' }, env))
    expect(entryStates(activeRun(state, 'chain'))).toEqual({
      [A]: 'rejected',
      [B]: 'pending',
      [C]: 'waiting',
    })
    state = run(decideStep(def, state, { stepId: step(), userId: B, decision: 'approve' }, env))
    state = run(decideStep(def, state, { stepId: step(), userId: C, decision: 'approve' }, env))
    expect(state.steps[0]?.outcome).toBe('approved')
    expect(state.status).toBe('finished')
  })

  it('onReject continue: маршрут идёт дальше, итог шага сохраняется для условий', () => {
    const def = route({
      review: { type: 'approval', assignees: ['var:x'], onReject: 'continue', next: 'check' },
      check: {
        type: 'condition',
        branches: [{ if: "steps.review.outcome = 'rejected'", next: 'bad' }],
        else: 'good',
      },
      bad: { type: 'end', outcome: 'declined' },
      good: { type: 'end' },
    })
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { review: [A] } })
    let state = run(startProcess(def, env))
    state = run(
      decideStep(
        def,
        state,
        { stepId: activeRun(state, 'review').id, userId: A, decision: 'reject' },
        env,
      ),
    )
    expect(state.outcome).toBe('declined')
    expect(stepsScope(state).review).toMatchObject({ outcome: 'rejected', status: 'completed' })
  })

  it('верхний параллельный шаг с join any и previous_step.assignees обычного шага', () => {
    const def = route({
      first: { type: 'approval', assignees: ['var:x'], next: 'fork' },
      fork: { type: 'parallel', branches: [['left'], ['right']], join: 'any', next: 'after' },
      left: { type: 'acknowledge', assignees: ['previous_step.assignees'] },
      right: { type: 'approval', assignees: ['var:x'] },
      after: { type: 'acknowledge', assignees: ['var:x'], next: 'end' },
      end: { type: 'end' },
    })
    const env = testEnv()
    const { run } = driver(def, env, {
      assignees: { first: [A], left: [A], right: [B], after: [C] },
    })
    let state = run(startProcess(def, env))
    state = run(
      decideStep(
        def,
        state,
        { stepId: activeRun(state, 'first').id, userId: A, decision: 'approve' },
        env,
      ),
    )
    // Ветви получили в качестве «предыдущего» шаг перед параллельным
    expect(previousAssignees(state, activeRun(state, 'left').id)).toEqual([A])
    state = run(
      decideStep(
        def,
        state,
        { stepId: activeRun(state, 'left').id, userId: A, decision: 'acknowledge' },
        env,
      ),
    )
    expect(activeKeys(state)).toEqual(['after'])
    expect(state.steps.find((item) => item.key === 'right')?.status).toBe('cancelled')
  })

  it('переназначение: замена ждущего и назначение в конец очереди', () => {
    const def = route({
      chain: { type: 'approval', mode: 'sequential', assignees: ['var:x'], next: 'end' },
      end: { type: 'end' },
    })
    const env = testEnv()
    const { run } = driver(def, env, { assignees: { chain: [A, B] } })
    let state = run(startProcess(def, env))
    const stepId = activeRun(state, 'chain').id
    state = run(reassignStep(def, state, { stepId, fromUserId: B, userIds: [C] }, env))
    expect(activeRun(state, 'chain').entries.map((item) => [item.userId, item.state])).toEqual([
      [A, 'pending'],
      [B, 'delegated'],
      [C, 'waiting'],
    ])
    state = run(reassignStep(def, state, { stepId, fromUserId: null, userIds: [D] }, env))
    expect(activeRun(state, 'chain').entries.at(-1)).toMatchObject({ userId: D, state: 'waiting' })
    expect(() =>
      reassignStep(def, state, { stepId, fromUserId: u('x'), userIds: [D] }, env),
    ).toThrowError('Этот сотрудник не ждёт решения')
  })
})
