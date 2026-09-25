import { describe, expect, it } from 'vitest'
import { canOpenAdmin, visibleAdminSections } from './sections.js'

describe('разделы консоли по способностям (N85)', () => {
  it('администратор ГИС видит только подложки и ГИС-службы', () => {
    expect([...visibleAdminSections(['gis.basemaps.manage'])]).toEqual(['basemaps', 'gisServices'])
    expect(canOpenAdmin(['gis.basemaps.manage'])).toBe(true)
  })

  it('аудитор безопасности — журнал и матрицу ролей', () => {
    expect([...visibleAdminSections(['admin.audit.read'])].sort()).toEqual(['audit', 'roles'])
  })

  it('без способностей разделов консоль не открывается', () => {
    expect(canOpenAdmin(['data.export', 'ai.use'])).toBe(false)
    expect(canOpenAdmin(undefined)).toBe(false)
  })
})
