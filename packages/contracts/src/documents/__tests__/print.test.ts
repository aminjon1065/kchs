import { describe, expect, it } from 'vitest'
import { DocumentRenderPlan, PrintPeriod, PrintRequestInput } from '../print.js'
import { classifyPlaceholders, templatePlaceholders } from '../template.js'

describe('плейсхолдеры шаблонов DOCX', () => {
  it('известные пути контекста — реквизиты, люди, организация', () => {
    const known = templatePlaceholders()
    expect(known).toEqual(
      expect.arrayContaining([
        'doc.subject',
        'doc.correspondent.name',
        'doc.attachments',
        'author.position',
        'signer.short_name',
        'org.name',
        'today',
      ]),
    )
  })

  it('поле карточки известно, если оно есть у типа шаблона', () => {
    const found = ['doc.subject', 'doc.fields.addressee', 'doc.fields.amount', 'foo.bar', 'doc']
    expect(classifyPlaceholders(found, ['addressee'])).toEqual({
      known: ['doc.fields.addressee', 'doc.subject'],
      unknown: ['doc', 'doc.fields.amount', 'foo.bar'],
    })
    // Шаблон без типа — любое поле по форме ключа
    expect(classifyPlaceholders(['doc.fields.amount', 'doc.fields.Bad-Key'], null)).toEqual({
      known: ['doc.fields.amount'],
      unknown: ['doc.fields.Bad-Key'],
    })
  })

  it('повторы убираются, порядок — по алфавиту', () => {
    expect(classifyPlaceholders(['today', 'org.name', 'today'], null).known).toEqual([
      'org.name',
      'today',
    ])
  })
})

describe('печатные формы', () => {
  it('период реестра: начало не позже конца', () => {
    expect(PrintPeriod.safeParse({ from: '2026-09-01', to: '2026-09-30' }).success).toBe(true)
    expect(PrintPeriod.safeParse({ from: '2026-10-01', to: '2026-09-30' }).success).toBe(false)
    expect(PrintPeriod.safeParse({ from: '2026-09-01', to: 'завтра' }).success).toBe(false)
  })

  it('параметры заказа по умолчанию пусты', () => {
    const parsed = PrintRequestInput.parse({
      subjectId: '01929a3e-1234-7abc-8def-0123456789ab',
      form: 'registration_card',
    })
    expect(parsed.params).toEqual({})
  })

  it('план движка — один из четырёх видов', () => {
    expect(
      DocumentRenderPlan.safeParse({
        kind: 'overlay',
        source: { bucket: 'files', storageKey: 'k', name: 'a.pdf', mime: 'application/pdf' },
        html: '<html></html>',
        pages: 'first',
      }).success,
    ).toBe(true)
    expect(DocumentRenderPlan.safeParse({ kind: 'script', code: 'rm -rf /' }).success).toBe(false)
  })
})
