import type { ProcessInstanceView, ProcessStepView } from '@kchs/process'
import { describe, expect, it } from 'vitest'
import type { Definition } from './model.js'
import { routeOverviewOf } from './route-overview-model.js'

const user = (id: string, displayName: string) => ({
  id,
  displayName,
  avatarUrl: null,
  position: null,
  unitName: null,
})

/** Экстренный маршрут донесения: регистрация → резолюция → исполнение → контроль. */
function emergency(): Definition {
  return {
    version: 1,
    key: 'report_emergency',
    objectType: 'document',
    name: { ru: 'Экстренный' },
    variables: {},
    start: 'register',
    steps: {
      register: {
        type: 'register',
        name: { ru: 'Регистрация' },
        dueHours: 1,
        next: 'resolve',
      },
      resolve: {
        type: 'approval',
        name: { ru: 'Резолюция' },
        assignees: [{ kind: 'user', id: 'boss' }],
        dueHours: 4,
        next: 'execute',
      },
      execute: {
        type: 'task',
        name: { ru: 'Исполнение' },
        assignees: [{ kind: 'user', id: 'boss' }],
        dueWorkingDays: 1,
        next: 'control',
      },
      control: {
        type: 'acknowledge',
        name: { ru: 'Контроль' },
        assignees: [{ kind: 'user', id: 'boss' }],
        next: 'done',
      },
      done: { type: 'end', outcome: 'completed' },
    },
  } as unknown as Definition
}

function step(patch: Partial<ProcessStepView> & Pick<ProcessStepView, 'id' | 'key' | 'type'>) {
  return {
    name: null,
    status: 'completed',
    outcome: null,
    round: 1,
    sequence: 1,
    parentId: null,
    branch: null,
    activatedAt: '2026-11-04T08:00:00Z',
    completedAt: '2026-11-04T08:34:00Z',
    dueAt: '2026-11-04T09:00:00Z',
    overdue: false,
    unassigned: false,
    assignees: [],
    actions: [],
    result: null,
    ...patch,
  } as ProcessStepView
}

function view(patch: Partial<ProcessInstanceView>): ProcessInstanceView {
  return {
    id: 'instance',
    objectId: 'document',
    definitionId: 'definition',
    definitionKey: 'report_emergency',
    version: 1,
    name: { ru: 'Экстренный' },
    status: 'running',
    outcome: null,
    round: 1,
    startedBy: null,
    startedAt: '2026-11-04T08:00:00Z',
    finishedAt: null,
    definition: emergency(),
    variables: {},
    steps: [],
    myActions: [],
    canCancel: false,
    ...patch,
  } as ProcessInstanceView
}

describe('маршрут шагами (ADR-0230)', () => {
  it('пройденное — по шагам экземпляра, текущий шаг смотрящего, будущее — по определению', () => {
    const overview = routeOverviewOf(
      view({
        steps: [
          step({ id: 's1', key: 'register', type: 'register', sequence: 1 }),
          step({
            id: 's2',
            key: 'resolve',
            type: 'approval',
            sequence: 2,
            status: 'active',
            completedAt: null,
            activatedAt: '2026-11-04T08:34:00Z',
            dueAt: '2026-11-04T12:34:00Z',
            assignees: [
              {
                user: user('boss', 'Саидов Б.'),
                state: 'pending',
                source: 'user',
                decidedAt: null,
                actor: null,
                addedBy: null,
                delegatedFrom: null,
                delegatedTo: null,
              },
            ],
          }),
        ],
        myActions: [
          {
            stepId: 's2',
            stepKey: 'resolve',
            type: 'approval',
            onBehalfOf: null,
            actions: ['approve'],
            requireMfa: false,
            qualified: false,
          },
        ],
      }),
    )
    expect(overview.steps.map((item) => [item.key, item.state])).toEqual([
      ['register', 'done'],
      ['resolve', 'current'],
      ['execute', 'upcoming'],
      ['control', 'upcoming'],
    ])
    expect(overview.hours).toBe(true)
    expect(overview.mine?.key).toBe('resolve')
    expect(overview.mine?.normHours).toBe(4)
    expect(overview.steps[1]?.people.map((person) => person.displayName)).toEqual(['Саидов Б.'])
    expect(overview.steps[2]?.normWorkingDays).toBe(1)
  })

  it('отклонённый шаг — крестом, у завершённого маршрута будущего нет', () => {
    const overview = routeOverviewOf(
      view({
        status: 'finished',
        outcome: 'rejected',
        steps: [
          step({ id: 's1', key: 'register', type: 'register', sequence: 1 }),
          step({ id: 's2', key: 'resolve', type: 'approval', sequence: 2, outcome: 'rejected' }),
        ],
      }),
    )
    expect(overview.steps.map((item) => [item.key, item.state])).toEqual([
      ['register', 'done'],
      ['resolve', 'rejected'],
    ])
    expect(overview.mine).toBeNull()
  })

  it('прошлый круг не смешивается с текущим, отменённые шаги не показываются', () => {
    const overview = routeOverviewOf(
      view({
        round: 2,
        steps: [
          step({ id: 'old', key: 'resolve', type: 'approval', round: 1, sequence: 2 }),
          step({ id: 'r2', key: 'register', type: 'register', round: 2, sequence: 3 }),
          step({
            id: 'gone',
            key: 'resolve',
            type: 'approval',
            round: 2,
            sequence: 4,
            status: 'cancelled',
          }),
        ],
      }),
    )
    expect(overview.steps.map((item) => [item.key, item.state])).toEqual([
      ['register', 'done'],
      ['resolve', 'upcoming'],
      ['execute', 'upcoming'],
      ['control', 'upcoming'],
    ])
  })
})
