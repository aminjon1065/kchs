import { describe, expect, it } from 'vitest'
import { allAssigneeExpressions, describeAssignee, principalKeysOf } from './assignees.js'

const USER = '0190a8f2-1c3b-7d4e-8f90-123456789abc'
const UNIT = '0190a8f2-1c3b-7d4e-8f90-cba987654321'

describe('выражения назначений', () => {
  it('частые формы распознаются словами, пробелы не важны', () => {
    expect(describeAssignee('unit_head( author.unit )')).toEqual({ kind: 'author_unit_head' })
    expect(describeAssignee('manager(unit_head(author.unit))')).toEqual({
      kind: 'author_unit_head_manager',
    })
    expect(describeAssignee(`user:${USER}`)).toEqual({ kind: 'user', key: `user:${USER}` })
    expect(describeAssignee(`UNIT:${UNIT.toUpperCase()}`)).toEqual({
      kind: 'unit',
      key: `unit:${UNIT}`,
    })
    expect(describeAssignee('role:registrar')).toEqual({ kind: 'role', role: 'registrar' })
    expect(describeAssignee("role_in_space('legal')")).toEqual({
      kind: 'role_in_space',
      role: 'legal',
    })
    expect(describeAssignee('var:signer')).toEqual({ kind: 'variable', name: 'signer' })
    expect(describeAssignee("field('responsible')")).toEqual({ kind: 'field', name: 'responsible' })
    expect(describeAssignee("unit_head('ОГД')")).toEqual({ kind: 'unit_head_code', code: 'ОГД' })
    expect(describeAssignee('manager(field:curator)')).toEqual({
      kind: 'expression',
      source: 'manager(field:curator)',
    })
  })

  it('ключи принципалов собираются без повторов со всего определения', () => {
    const definition = {
      steps: {
        a: { type: 'approval', assignees: [`user:${USER}`, 'author', `unit:${UNIT}`] },
        b: { type: 'notify', to: `user:${USER}` },
        c: { type: 'return', to: 'author' },
      },
      timers: [{ step: '*', onOverdue: [{ action: 'notify', to: ['manager(step.assignee)'] }] }],
    }
    const expressions = allAssigneeExpressions(definition)
    expect(expressions).toEqual(
      expect.arrayContaining([`user:${USER}`, 'author', `unit:${UNIT}`, 'manager(step.assignee)']),
    )
    expect(principalKeysOf(expressions)).toEqual([`unit:${UNIT}`, `user:${USER}`])
  })
})
