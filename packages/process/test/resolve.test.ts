import { describe, expect, it } from 'vitest'
import { type ResolveContext, resolveAssignees } from '../src/index.js'
import { fakeDirectory, u } from './fixtures.js'

/**
 * Оргструктура: организация (глава — chief) → управление (глава — boss) →
 * отдел (глава — lead, сотрудники author, peer). Юрист организации — lawyer,
 * юрист пространства «space-a» — lawyerA.
 */
const UNIT_ORG = '10000000-0000-4000-8000-000000000001'
const UNIT_DEP = '10000000-0000-4000-8000-000000000002'
const UNIT_TEAM = '10000000-0000-4000-8000-000000000003'
const GROUP = '20000000-0000-4000-8000-000000000001'
const SPACE_A = '30000000-0000-4000-8000-00000000000a'
const SPACE_B = '30000000-0000-4000-8000-00000000000b'

const directory = fakeDirectory({
  units: {
    [UNIT_ORG]: { head: u('chief'), code: 'ORG', members: [u('chief')] },
    [UNIT_DEP]: { parent: UNIT_ORG, head: u('boss'), code: 'DEP', members: [u('boss')] },
    [UNIT_TEAM]: {
      parent: UNIT_DEP,
      head: u('lead'),
      code: 'TEAM',
      members: [u('lead'), u('author'), u('peer'), u('gone')],
    },
  },
  groups: { [GROUP]: [u('peer'), u('lead')] },
  roles: [
    { key: 'registrar', userId: u('reg') },
    { key: 'registrar', userId: u('regA'), spaceId: SPACE_A },
    { key: 'legal', userId: u('lawyer') },
    { key: 'legal', userId: u('lawyrA'), spaceId: SPACE_A },
  ],
  spaceRoles: { [SPACE_A]: { [u('author')]: 'admin', [u('peer')]: 'editor' } },
  inactive: [u('gone')],
})

const context: ResolveContext = {
  authorId: u('author'),
  initiatorId: u('peer'),
  spaceId: SPACE_A,
  variables: {
    signer: u('chief'),
    reviewers: [u('peer'), { id: u('boss') }],
    department: UNIT_DEP,
    board: GROUP,
  },
  variableTypes: { signer: 'user', reviewers: 'users', department: 'unit', board: 'group' },
  fields: { responsible_id: u('lead'), card: { controller: u('boss') }, amount: 5 },
  chosen: [u('peer')],
  previousAssignees: [u('lead'), u('boss')],
}

async function users(expression: string, overrides: Partial<ResolveContext> = {}) {
  const result = await resolveAssignees([expression], { ...context, ...overrides }, directory)
  return result.assignees.map((item) => item.userId)
}

describe('резолвер назначений', () => {
  it.each([
    [`user:${u('peer')}`, [u('peer')]],
    [`group:${GROUP}`, [u('peer'), u('lead')]],
    // подразделение — с вложенными, без неактивных
    [`unit:${UNIT_DEP}`, [u('boss'), u('lead'), u('author'), u('peer')]],
    ['author', [u('author')]],
    ['initiator', [u('peer')]],
    ['author.unit', [u('lead'), u('author'), u('peer')]],
    ['unit_head(author.unit)', [u('lead')]],
    ["unit_head('DEP')", [u('boss')]],
    ['unit_head(var:department)', [u('boss')]],
    ['manager(author)', [u('lead')]],
    // руководитель главы отдела — глава управления
    ['manager(unit_head(author.unit))', [u('boss')]],
    ['manager(manager(unit_head(author.unit)))', [u('chief')]],
    ['var:signer', [u('chief')]],
    ['var:reviewers', [u('peer'), u('boss')]],
    ['var:board', [u('peer'), u('lead')]],
    ['var:department', [u('boss'), u('lead'), u('author'), u('peer')]],
    ['field:responsible_id', [u('lead')]],
    ['field:card.controller', [u('boss')]],
    ['field:amount', []],
    ['chosen_by_initiator', [u('peer')]],
    ['previous_step.assignees', [u('lead'), u('boss')]],
    // роль: без ограничения и ограниченная пространством объекта
    ['role:registrar', [u('reg'), u('regA')]],
    // роль в пространстве: своя, иначе — без ограничения
    ['role_in_space:legal', [u('lawyrA')]],
    // роль участника пространства
    ['role_in_space:editor', [u('peer')]],
  ])('%s', async (expression, expected) => {
    expect(await users(expression)).toEqual(expected)
  })

  it('роль в другом пространстве — юрист организации', async () => {
    expect(await users('role_in_space:legal', { spaceId: SPACE_B })).toEqual([u('lawyer')])
    expect(await users('role:registrar', { spaceId: SPACE_B })).toEqual([u('reg')])
  })

  it('порядок выражений сохраняется, повторы убираются', async () => {
    const result = await resolveAssignees(
      ['unit_head(author.unit)', 'author', `user:${u('lead')}`, 'var:reviewers'],
      context,
      directory,
    )
    expect(result.assignees).toEqual([
      { userId: u('lead'), source: 'unit_head(author.unit)' },
      { userId: u('author'), source: 'author' },
      { userId: u('peer'), source: 'var:reviewers' },
      { userId: u('boss'), source: 'var:reviewers' },
    ])
    expect(result.issues).toEqual([])
  })

  it('подразделение автора задаёт объект', async () => {
    expect(await users('unit_head(author.unit)', { authorUnitId: UNIT_DEP })).toEqual([u('boss')])
    expect(await users('unit_head(author.unit)', { authorUnitId: null })).toEqual([])
  })

  it('неактивный пользователь не назначается', async () => {
    expect(await users(`user:${u('gone')}`)).toEqual([])
  })

  it('проблемы: пусто, неверно, известно только при исполнении', async () => {
    const result = await resolveAssignees(
      ['manager(user:00000000-0000-4000-8000-00000000dead)', 'boss', 'previous_step.assignees'],
      { ...context, previousAssignees: undefined },
      directory,
    )
    expect(result.assignees).toEqual([])
    expect(result.issues).toEqual([
      {
        expression: 'manager(user:00000000-0000-4000-8000-00000000dead)',
        code: 'empty',
        message: 'Никто не назначен: manager(user:00000000-0000-4000-8000-00000000dead)',
      },
      { expression: 'boss', code: 'invalid', message: 'Неизвестное выражение «boss»' },
      {
        expression: 'previous_step.assignees',
        code: 'runtime',
        message: 'Определяется при исполнении маршрута',
      },
    ])
  })
})
