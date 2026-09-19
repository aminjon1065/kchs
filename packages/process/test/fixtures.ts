import { evaluateCondition } from '@kchs/query/expr'
import {
  type AssigneeDirectory,
  assignStep,
  completeStep,
  type InstanceState,
  type MachineEnv,
  type ProcessDefinition,
  type ProcessDefinitionInput,
  ProcessDefinition as ProcessDefinitionSchema,
  type StepRun,
  type Transition,
} from '../src/index.js'

/** Идентификатор-«пользователь» для читаемых тестов: `u('legal')`. */
export function u(name: string): string {
  const hex = [...name].map((char) => char.charCodeAt(0).toString(16)).join('')
  return `00000000-0000-4000-8000-${hex.padStart(12, '0').slice(-12)}`
}

/** Переменные тестовых маршрутов: `var:x`, `var:reviewers` — люди, `var:signer` — подписант. */
const TEST_VARIABLES: ProcessDefinitionInput['variables'] = {
  x: { type: 'users', label: { ru: 'Назначенные' } },
  reviewers: { type: 'users', label: { ru: 'Согласующие' } },
  signer: { type: 'user', label: { ru: 'Подписант' } },
}

export function define(input: ProcessDefinitionInput): ProcessDefinition {
  return ProcessDefinitionSchema.parse({
    ...input,
    variables: { ...TEST_VARIABLES, ...(input.variables ?? {}) },
  })
}

/** Счётчик идентификаторов на весь прогон: среды разных переходов не пересекаются. */
let counter = 0

/** Среда перехода: предсказуемые идентификаторы и время, условия — по данным. */
export function testEnv(data: Record<string, unknown> = {}): MachineEnv {
  return {
    now: '2026-09-21T05:00:00.000Z',
    newId: () => `step-${String(++counter).padStart(5, '0')}`,
    evaluate: (source, scope) =>
      evaluateCondition(source, {
        resolve: (path) => {
          let current: unknown = { ...data, steps: scope.steps }
          for (const part of path) {
            if (current === null || typeof current !== 'object') return undefined
            current = (current as Record<string, unknown>)[part]
          }
          return current
        },
      }),
  }
}

/**
 * Исполнитель для тестов — как ядро: назначенные шагов из таблицы
 * «ключ шага → пользователи», автоматические шаги выполняются сразу
 * (кроме перечисленных в `waitFor`).
 */
export function driver(
  def: ProcessDefinition,
  env: MachineEnv,
  options: {
    assignees?: Record<string, string[]>
    waitFor?: string[]
  } = {},
) {
  const pending: Array<{ kind: string; stepId: string }> = []
  const run = (transition: Transition): InstanceState => {
    let state = transition.state
    pending.push(...transition.work)
    while (pending.length > 0) {
      const item = pending.shift()
      if (!item) break
      const step = state.steps.find((candidate) => candidate.id === item.stepId)
      if (step?.status !== 'active') continue
      if (item.kind === 'resolve') {
        const users = options.assignees?.[step.key] ?? []
        const next = assignStep(
          def,
          state,
          {
            stepId: step.id,
            assignees: users.map((userId) => ({ userId, source: `test:${step.key}` })),
            dueAt: null,
          },
          env,
        )
        state = next.state
        pending.push(...next.work)
      } else if (item.kind === 'run' && !options.waitFor?.includes(step.key)) {
        const next = completeStep(def, state, { stepId: step.id, outcome: 'done' }, env)
        state = next.state
        pending.push(...next.work)
      }
    }
    return state
  }
  return { run }
}

/** Активная активация шага по ключу. */
export function activeRun(state: InstanceState, key: string): StepRun {
  const run = state.steps.find((item) => item.key === key && item.status === 'active')
  if (!run) {
    const active = state.steps.filter((item) => item.status === 'active').map((item) => item.key)
    throw new Error(`шаг «${key}» не активен; активны: ${active.join(', ') || 'нет'}`)
  }
  return run
}

export function activeKeys(state: InstanceState): string[] {
  return state.steps.filter((item) => item.status === 'active').map((item) => item.key)
}

export function entryStates(run: StepRun): Record<string, string> {
  return Object.fromEntries(run.entries.map((item) => [item.userId, item.state]))
}

/**
 * Справочник в памяти: подразделения (дерево), руководители, группы, роли
 * (с пространством), неактивные пользователи.
 */
export interface FakeOrg {
  units: Record<string, { parent?: string; head?: string; code?: string; members: string[] }>
  groups?: Record<string, string[]>
  roles?: Array<{ key: string; userId: string; spaceId?: string | null }>
  spaceRoles?: Record<string, Record<string, string>>
  inactive?: string[]
}

export function fakeDirectory(org: FakeOrg): AssigneeDirectory & { calls: string[] } {
  const calls: string[] = []
  const unitOf = (userId: string) =>
    Object.entries(org.units).find(([, unit]) => unit.members.includes(userId))?.[0] ?? null
  const descendants = (unitId: string): string[] => [
    unitId,
    ...Object.entries(org.units)
      .filter(([, unit]) => unit.parent === unitId)
      .flatMap(([id]) => descendants(id)),
  ]
  return {
    calls,
    activeUsers: async (ids) => ids.filter((id) => !org.inactive?.includes(id)),
    groupMembers: async (groupId) => {
      calls.push(`group:${groupId}`)
      return org.groups?.[groupId] ?? []
    },
    unitMembers: async (unitId) =>
      descendants(unitId).flatMap((id) => org.units[id]?.members ?? []),
    unitHead: async (unitId) => org.units[unitId]?.head ?? null,
    manager: async (userId) => {
      const unitId = unitOf(userId)
      if (!unitId) return null
      const unit = org.units[unitId]
      if (unit?.head && unit.head !== userId) return unit.head
      const parent = unit?.parent ? org.units[unit.parent] : undefined
      return parent?.head ?? null
    },
    primaryUnit: async (userId) => unitOf(userId),
    unitByCode: async (code) =>
      Object.entries(org.units).find(([, unit]) => unit.code === code)?.[0] ?? null,
    usersWithRole: async (key, spaceId) =>
      (org.roles ?? [])
        .filter((role) => role.key === key && (!role.spaceId || role.spaceId === spaceId))
        .map((role) => role.userId),
    usersWithRoleInSpace: async (key, spaceId) => {
      const members = spaceId ? org.spaceRoles?.[spaceId] : undefined
      const order = ['viewer', 'member', 'editor', 'admin']
      if (order.includes(key)) {
        // роль участника пространства — «не ниже», как у принципала space_role
        return Object.entries(members ?? {})
          .filter(([, role]) => order.indexOf(role) >= order.indexOf(key))
          .map(([userId]) => userId)
      }
      const scoped = (org.roles ?? []).filter(
        (role) => role.key === key && role.spaceId === spaceId,
      )
      const pool =
        scoped.length > 0 ? scoped : (org.roles ?? []).filter((r) => r.key === key && !r.spaceId)
      return pool.map((role) => role.userId)
    },
  }
}

/** Пример из contracts/process-definition.md — дословно. */
export const CONTRACT_EXAMPLE = {
  version: 1,
  key: 'outgoing_letter_default',
  objectType: 'document',
  name: { ru: 'Исходящее письмо: стандартный маршрут' },
  variables: { signer: { type: 'user', label: { ru: 'Подписант' }, required: true } },
  start: 'legal_review',
  steps: {
    legal_review: {
      type: 'approval',
      name: { ru: 'Согласование' },
      mode: 'parallel',
      quorum: 'all',
      assignees: ['role_in_space:legal', 'unit_head(author.unit)'],
      dueWorkingDays: 3,
      onReject: 'return_to_author',
      allowAddApprover: true,
      next: 'deputy_review',
    },
    deputy_review: {
      type: 'approval',
      mode: 'sequential',
      assignees: ['manager(unit_head(author.unit))'],
      dueWorkingDays: 2,
      next: 'sign',
    },
    sign: {
      type: 'sign',
      assignees: ['var:signer'],
      dueWorkingDays: 2,
      requireMfa: true,
      next: 'register',
    },
    register: {
      type: 'register',
      assignees: ['role:registrar'],
      journal: 'outgoing',
      next: 'dispatch',
    },
    dispatch: {
      type: 'task',
      title: { ru: 'Отправить корреспонденту' },
      assignees: ['role:registrar'],
      dueWorkingDays: 1,
      next: 'end',
    },
    return_to_author: {
      type: 'return',
      to: 'author',
      reapproval: 'rejecters_only',
      next: 'legal_review',
    },
    end: { type: 'end', outcome: 'completed' },
  },
  timers: [
    {
      step: '*',
      onOverdue: [
        { action: 'notify', to: 'manager(step.assignee)' },
        { action: 'notify', to: 'author' },
      ],
    },
  ],
  conditions: [
    {
      at: 'start',
      if: 'object.fields.amount > 1000000',
      insertBefore: 'deputy_review',
      step: { type: 'approval', assignees: ['role_in_space:finance'], dueWorkingDays: 2 },
    },
  ],
}
