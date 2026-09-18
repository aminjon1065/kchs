import type { FieldDef } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { isRequired, isVisible, normalizeValues, validateValues } from '../validate.js'

const field = (patch: Partial<FieldDef> & Pick<FieldDef, 'key' | 'type'>): FieldDef => ({
  label: { ru: patch.key },
  semantic: 'dimension',
  required: false,
  unique: false,
  indexed: false,
  sensitive: false,
  readOnly: false,
  nullable: true,
  order: 0,
  ...patch,
})

const kind = field({
  key: 'kind',
  type: 'select',
  options: [
    { value: 'incoming', label: { ru: 'Входящий' } },
    { value: 'outgoing', label: { ru: 'Исходящий' } },
  ],
})
const sender = field({
  key: 'sender',
  type: 'text',
  visibleIf: { field: 'kind', op: 'eq', value: 'incoming' },
  requiredIf: { field: 'kind', op: 'eq', value: 'incoming' },
})
const pages = field({ key: 'pages', type: 'integer', validation: { min: 1 } })

describe('validateValues', () => {
  it('пустое число — «не задано», а не 0', () => {
    expect(normalizeValues([pages], { pages: '' })).toEqual({ pages: null })
    expect(validateValues([pages], { pages: '' })).toMatchObject({
      ok: true,
      data: { pages: null },
    })
    expect(validateValues([pages], { pages: '0' }).ok).toBe(false)
  })

  it('условная обязательность и видимость', () => {
    const fields = [kind, sender]
    expect(isVisible(sender, { kind: 'outgoing' })).toBe(false)
    expect(isRequired(sender, { kind: 'incoming' })).toBe(true)
    // Скрытое поле не проверяется
    expect(validateValues(fields, { kind: 'outgoing' }).ok).toBe(true)
    const missing = validateValues(fields, { kind: 'incoming', sender: '   ' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.issues[0]?.path).toBe('sender')
    expect(validateValues(fields, { kind: 'incoming', sender: 'Минфин' }).ok).toBe(true)
  })

  it('значение справочника проверяется по вариантам', () => {
    expect(validateValues([kind], { kind: 'lost' }).ok).toBe(false)
  })
})
