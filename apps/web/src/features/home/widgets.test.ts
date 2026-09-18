import { describe, expect, it } from 'vitest'
import { HOME_WIDGETS, presetFor, widgetsFor } from './widgets.js'

describe('виджеты «Мой день»', () => {
  it('набор по роли; у нескольких ролей — первое совпадение, без роли — все', () => {
    expect(presetFor(['registrar'])[0]).toBe('inbox')
    expect(presetFor(['employee', 'data_steward'])[0]).toBe('continue')
    expect(presetFor(['system_admin'])[0]).toBe('announcements')
    expect(presetFor(['employee'])).toEqual([...HOME_WIDGETS])
  })

  it('сохранённый выбор важнее роли; порядок сохраняется', () => {
    expect(widgetsFor(['pinned', 'inbox'], ['registrar'])).toEqual(['pinned', 'inbox'])
  })

  it('«Мои задачи» — в наборе каждой роли', () => {
    for (const roles of [['registrar'], ['data_steward'], ['system_admin'], ['employee']]) {
      expect(presetFor(roles)).toContain('tasks')
    }
  })

  it('исчезнувшие виджеты и повторы отбрасываются, мусор — набор по роли', () => {
    expect(widgetsFor(['team', 'inbox', 'inbox'], ['employee'])).toEqual(['inbox'])
    expect(widgetsFor(['team'], ['registrar'])).toEqual(presetFor(['registrar']))
    expect(widgetsFor('inbox', ['registrar'])).toEqual(presetFor(['registrar']))
    expect(widgetsFor(undefined, ['employee'])).toEqual(presetFor(['employee']))
  })

  it('пустой сохранённый список — осознанный выбор «ничего не показывать»', () => {
    expect(widgetsFor([], ['employee'])).toEqual([])
  })
})
