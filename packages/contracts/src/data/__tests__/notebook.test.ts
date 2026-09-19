import { describe, expect, it } from 'vitest'
import { richBodyText, safeHref } from '../../common/rich-text.js'
import {
  applyNotebookParams,
  NotebookCell,
  NotebookCreateInput,
  notebookParamFields,
} from '../notebook.js'
import type { QuerySpec } from '../query.js'

const DATASET = '01890000-0000-7000-8000-000000000001'

const FIELDS = [
  { key: 'code', type: 'text' },
  { key: 'incident_date', type: 'date' },
  { key: 'reported_at', type: 'datetime' },
  { key: 'district', type: 'territory' },
  { key: 'region', type: 'territory' },
]

const spec: QuerySpec = {
  version: 1,
  source: { kind: 'dataset', id: DATASET },
  steps: [{ type: 'aggregate', groupBy: [], measures: [{ alias: 'n', agg: 'count' }] }],
  params: {},
  options: { cache: true, approxCount: true },
}

describe('контракт тетради', () => {
  it('ячейки по умолчанию: пустой текст, запрос-количество, ИИ без ответа', () => {
    const input = NotebookCreateInput.parse({
      name: 'Сводка',
      spaceId: DATASET,
      cells: [
        { id: 't', kind: 'text' },
        { id: 'q', kind: 'query', datasetId: DATASET },
        { id: 'a', kind: 'ai' },
      ],
    })
    expect(input.cells[0]).toEqual({
      id: 't',
      kind: 'text',
      title: null,
      body: { type: 'doc', content: [] },
    })
    expect(input.cells[1]).toMatchObject({
      mode: 'visual',
      sql: '',
      plan: { measures: [{ agg: 'count' }] },
      view: 'chart',
      bindings: {},
    })
    expect(input.cells[2]).toMatchObject({ question: '', answer: null, datasetId: null })
    expect(input.params).toEqual({ period: null, territory: null })
    expect(NotebookCell.safeParse({ id: 'плохой id', kind: 'text' }).success).toBe(false)
  })

  it('поля параметров: привязка ячейки, иначе первое поле даты и поле территории датасета', () => {
    expect(notebookParamFields({}, FIELDS)).toEqual({
      period: 'incident_date',
      territory: 'district',
    })
    expect(notebookParamFields({}, FIELDS, 'region')).toEqual({
      period: 'incident_date',
      territory: 'region',
    })
    expect(notebookParamFields({ period: 'reported_at', territory: null }, FIELDS)).toEqual({
      period: 'reported_at',
      territory: null,
    })
    // Привязка к полю, которого больше нет, — параметр не применяется
    expect(notebookParamFields({ period: 'gone' }, FIELDS).period).toBeNull()
    expect(notebookParamFields({}, [{ key: 'code', type: 'text' }])).toEqual({
      period: null,
      territory: null,
    })
  })

  it('параметры → фильтр в начале запроса; не заданы — запрос прежний', () => {
    const fields = { period: 'incident_date', territory: 'district' }
    expect(applyNotebookParams(spec, { period: null, territory: null }, fields)).toBe(spec)
    const relative = applyNotebookParams(
      spec,
      { period: { unit: 'month', from: 0, to: 0 }, territory: { id: 'T1', includeChildren: true } },
      fields,
    )
    expect(relative.steps[0]).toEqual({
      type: 'filter',
      where: {
        and: [
          { field: 'incident_date', op: 'relative', value: { unit: 'month', from: 0, to: 0 } },
          { field: 'district', op: 'within', value: { id: 'T1', includeChildren: true } },
        ],
      },
    })
    expect(relative.steps.slice(1)).toEqual(spec.steps)
    const dates = applyNotebookParams(
      spec,
      { period: { from: '2026-01-01', to: '2026-03-31' }, territory: null },
      { period: 'incident_date', territory: null },
    )
    expect(dates.steps[0]).toEqual({
      type: 'filter',
      where: { field: 'incident_date', op: 'between', value: ['2026-01-01', '2026-03-31'] },
    })
  })

  it('текст документа Tiptap: строки блоков, списки вглубь, упоминания', () => {
    expect(
      richBodyText({
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Итоги' }] },
          { type: 'paragraph' },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Отвечает ' },
              { type: 'mention', attrs: { id: 'u1', label: 'Иванов' } },
            ],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Хатлон' }] }],
              },
            ],
          },
        ],
      }),
    ).toBe('Итоги\nОтвечает @Иванов\nХатлон')
    expect(safeHref(' https://kchs.tj ')).toBe('https://kchs.tj')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('/o/123')).toBe('/o/123')
  })
})
