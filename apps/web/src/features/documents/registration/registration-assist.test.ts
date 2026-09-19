import { describe, expect, it } from 'vitest'
import { confidenceTone } from '../assist/queries.js'
import { emptyCardValue } from '../card/requisites-form.js'
import { applySuggestion } from './registration-assist.js'

describe('помощник регистрации', () => {
  const types = new Map([
    ['pages', 'integer'],
    ['enclosures', 'text'],
  ])

  it('реквизит — строкой формы, поле карточки — по типу поля', () => {
    const base = emptyCardValue('internal')
    const subject = applySuggestion(base, { key: 'subject', value: 'О паводке' }, types)
    expect(subject.subject).toBe('О паводке')
    const pages = applySuggestion(subject, { key: 'fields.pages', value: '3' }, types)
    expect(pages.fields).toEqual({ pages: 3 })
    const text = applySuggestion(pages, { key: 'fields.enclosures', value: 'Смета' }, types)
    expect(text.fields).toEqual({ pages: 3, enclosures: 'Смета' })
    // Не число для числового поля — остаётся строкой, форма покажет ошибку
    expect(applySuggestion(base, { key: 'fields.pages', value: 'три' }, types).fields).toEqual({
      pages: 'три',
    })
    // Неизвестный ключ не меняет карточку
    expect(applySuggestion(base, { key: 'confidentiality', value: 'secret' }, types)).toBe(base)
  })

  it('тон уверенности: уверенно, проверьте, сомнительно', () => {
    expect(confidenceTone(0.93)).toBe('success')
    expect(confidenceTone(0.6)).toBe('warning')
    expect(confidenceTone(0.2)).toBe('danger')
  })
})
