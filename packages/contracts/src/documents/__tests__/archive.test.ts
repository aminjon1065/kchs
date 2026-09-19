import { describe, expect, it } from 'vitest'
import { CaseCreateInput, caseDestroyableFrom } from '../case.js'
import { DOCUMENT_LINK_KINDS, DocumentDispatchInput } from '../correspondence.js'
import { canTransition } from '../lifecycle.js'

describe('дела номенклатуры (ADR-0086)', () => {
  it('срок хранения считается с 1 января года, следующего за годом дела', () => {
    expect(caseDestroyableFrom(2026, 5)).toBe('2032-01-01')
    expect(caseDestroyableFrom(2020, 1)).toBe('2022-01-01')
    expect(caseDestroyableFrom(2026, null)).toBeNull()
  })

  it('дело: индекс и заголовок обязательны, срок — от года, постоянное хранение — null', () => {
    const parsed = CaseCreateInput.parse({ index: ' 01-05 ', title: 'Переписка', year: 2026 })
    expect(parsed).toMatchObject({ index: '01-05', retentionYears: null, documentTypeIds: [] })
    expect(CaseCreateInput.safeParse({ index: '', title: 'Переписка', year: 2026 }).success).toBe(
      false,
    )
    expect(
      CaseCreateInput.safeParse({ index: '01', title: 'Т', year: 2026, retentionYears: 0 }).success,
    ).toBe(false)
  })

  it('подшивка и архив — рёбра графа жизненного цикла', () => {
    expect(canTransition('executed', 'filed')).toBe(true)
    expect(canTransition('registered', 'executed')).toBe(true)
    expect(canTransition('filed', 'archived')).toBe(true)
    expect(canTransition('registered', 'filed')).toBe(false)
    expect(canTransition('archived', 'filed')).toBe(false)
  })
})

describe('переписка и отправка (ADR-0086)', () => {
  it('отметка отправки: адресат — корреспондент или текст', () => {
    const base = { method: 'post', sentOn: '2026-09-19' }
    expect(
      DocumentDispatchInput.safeParse({
        ...base,
        correspondentId: '01900000-0000-7000-8000-000000000000',
      }).success,
    ).toBe(true)
    expect(DocumentDispatchInput.safeParse({ ...base, addressee: 'Хукумат' }).success).toBe(true)
    const missing = DocumentDispatchInput.safeParse({ ...base, addressee: '  ' })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues[0]?.path).toEqual(['addressee'])
  })

  it('виды связей документов — виды связей ядра', () => {
    expect(DOCUMENT_LINK_KINDS).toContain('reply_to')
    expect(DOCUMENT_LINK_KINDS).toContain('in_execution_of')
    expect(DOCUMENT_LINK_KINDS).not.toContain('attachment')
  })
})
