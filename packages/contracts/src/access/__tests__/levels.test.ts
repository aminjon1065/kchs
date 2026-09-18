import { describe, expect, it } from 'vitest'
import {
  atLeast,
  LEVELS,
  levelFromValue,
  levelValue,
  maxLevel,
  minLevel,
  SPACE_ROLE_DEFAULT_LEVEL,
} from '../levels.js'
import { parsePrincipal, principalKey } from '../principals.js'

describe('уровни доступа', () => {
  it('упорядочены none < view < comment < edit < manage < owner', () => {
    const values = LEVELS.map(levelValue)
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })

  it('atLeast сравнивает по порядку', () => {
    expect(atLeast('edit', 'view')).toBe(true)
    expect(atLeast('edit', 'edit')).toBe(true)
    expect(atLeast('comment', 'edit')).toBe(false)
    expect(atLeast('none', 'view')).toBe(false)
    expect(atLeast('owner', 'manage')).toBe(true)
  })

  it('maxLevel и minLevel', () => {
    expect(maxLevel('view', 'edit', 'comment')).toBe('edit')
    expect(minLevel('view', 'edit', 'comment')).toBe('view')
    expect(maxLevel()).toBe('none')
  })

  it('levelFromValue устойчив к выходу за границы', () => {
    expect(levelFromValue(-5)).toBe('none')
    expect(levelFromValue(0)).toBe('none')
    expect(levelFromValue(3)).toBe('edit')
    expect(levelFromValue(99)).toBe('owner')
  })

  it('роли пространства дают уровни по умолчанию', () => {
    expect(SPACE_ROLE_DEFAULT_LEVEL.viewer).toBe('view')
    expect(SPACE_ROLE_DEFAULT_LEVEL.member).toBe('comment')
    expect(SPACE_ROLE_DEFAULT_LEVEL.editor).toBe('edit')
    expect(SPACE_ROLE_DEFAULT_LEVEL.admin).toBe('manage')
  })
})

describe('принципалы', () => {
  it('ключ и разбор обратимы', () => {
    const principal = { type: 'user' as const, id: '01a0-b0b2' }
    expect(principalKey(principal)).toBe('user:01a0-b0b2')
    expect(parsePrincipal('user:01a0-b0b2')).toEqual(principal)
  })

  it('space_role сохраняет составной идентификатор', () => {
    const parsed = parsePrincipal('space_role:01a0:editor')
    expect(parsed.type).toBe('space_role')
    expect(parsed.id).toBe('01a0:editor')
  })

  it('некорректный ключ отклоняется', () => {
    expect(() => parsePrincipal('broken')).toThrow()
  })
})
