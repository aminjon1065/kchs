import { ReportBlock } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { reportSections, tocModel } from './print-sections.js'

const heading = (text: string, level: number) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
})

const blocks = [
  ReportBlock.parse({
    id: 't1',
    kind: 'text',
    body: {
      type: 'doc',
      content: [
        heading('Обстановка', 2),
        { type: 'paragraph', content: [{ type: 'text', text: 'текст' }] },
        heading('По районам', 3),
      ],
    },
  }),
  ReportBlock.parse({ id: 'm1', kind: 'metrics', title: 'Показатели' }),
  ReportBlock.parse({ id: 'q1', kind: 'query', title: null }),
  ReportBlock.parse({ id: 'b1', kind: 'page_break' }),
]

describe('разделы отчёта: оглавление и нумерация', () => {
  it('заголовки текста и подписи блоков — разделы и подразделы по порядку', () => {
    const { toc } = reportSections(blocks, false)
    expect(toc).toEqual([
      { level: 1, number: '1.', text: 'Обстановка' },
      { level: 2, number: '1.1.', text: 'По районам' },
      { level: 1, number: '2.', text: 'Показатели' },
    ])
  })

  it('нумерация пишется в заголовки и подписи; без неё блоки не меняются', () => {
    const plain = reportSections(blocks, false).blocks
    expect(plain).toEqual(blocks)
    const numbered = reportSections(blocks, true).blocks
    const text = numbered[0] as Extract<ReportBlock, { kind: 'text' }>
    expect((text.body.content[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      '1. ',
    )
    expect(numbered[1]?.title).toBe('2. Показатели')
    expect(numbered[2]?.title).toBeNull()
  })

  it('оглавление в модели DOCX — текст и разрыв страницы, пустое — ничего', () => {
    const { toc } = reportSections(blocks, true)
    const model = tocModel(toc, 'Содержание', true)
    expect(model.map((item) => item.kind)).toEqual(['text', 'page_break'])
    expect(tocModel([], 'Содержание', true)).toEqual([])
  })
})
