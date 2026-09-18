import { OBJECT_TYPES } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { hasObjectIcon, OBJECT_ICONS } from './object-icon.js'

describe('глифы типов объектов', () => {
  it('у каждого типа реестра есть глиф', () => {
    expect(OBJECT_TYPES.filter((type) => !hasObjectIcon(type))).toEqual([])
  })

  it('типы реестра различимы: глифы не повторяются', () => {
    const byGlyph = new Map<unknown, string[]>()
    for (const type of OBJECT_TYPES) {
      const glyph = OBJECT_ICONS[type]
      byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), type])
    }
    expect([...byGlyph.values()].filter((types) => types.length > 1)).toEqual([])
  })
})
