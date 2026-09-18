import type { DatasetField } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { type AskAnswer, answerToPlan, askableFields } from './ask-plan.js'

const field = (key: string, type: DatasetField['type']): DatasetField =>
  ({
    id: '0190f5a0-0000-7000-8000-000000000001',
    key,
    label: { ru: key },
    type,
    semantic: 'dimension',
    required: false,
    unique: false,
    indexed: false,
    sensitive: false,
    readOnly: false,
    nullable: true,
    order: 0,
  }) as DatasetField

const FIELDS = [
  field('district', 'select'),
  field('amount', 'number'),
  field('day', 'date'),
  field('comment', 'text'),
]

const answer = (patch: Partial<AskAnswer>): AskAnswer => ({
  answerable: true,
  reason: '',
  title: 'Обращения',
  explanation: 'Количество обращений',
  conditions: [],
  groups: [],
  measures: [],
  sort: null,
  limit: null,
  chart: 'bar',
  ...patch,
})

describe('«Спросить данные»: ответ модели → план исследования', () => {
  it('разрез, количество и сортировка по алиасу меры', () => {
    const converted = answerToPlan(
      answer({
        groups: [{ field: 'district', bucket: null }],
        measures: [{ agg: 'count', field: null }],
        sort: { by: 'count', dir: 'desc' },
        limit: 5,
      }),
      FIELDS,
    )
    expect(converted).toEqual({
      ok: true,
      plan: {
        filter: null,
        groups: [{ field: 'district' }],
        measures: [{ agg: 'count' }],
        sort: { field: 'count', dir: 'desc' },
        limit: 5,
      },
      chart: 'bar',
      title: 'Обращения',
      explanation: 'Количество обращений',
    })
  })

  it('условия всех видов собираются через И', () => {
    const converted = answerToPlan(
      answer({
        conditions: [
          {
            field: 'district',
            op: 'in',
            value: null,
            values: ['khatlon', 'sughd'],
            relative: null,
          },
          { field: 'amount', op: 'between', value: null, values: [10, 100], relative: null },
          {
            field: 'day',
            op: 'relative',
            value: null,
            values: null,
            relative: { unit: 'month', from: -1, to: -1 },
          },
          { field: 'comment', op: 'is_empty', value: 'лишнее', values: null, relative: null },
          { field: 'comment', op: 'neq', value: 'тест', values: null, relative: null },
        ],
        measures: [{ agg: 'sum', field: 'amount' }],
      }),
      FIELDS,
    )
    expect(converted.ok && converted.plan.filter).toEqual({
      and: [
        { field: 'district', op: 'in', value: ['khatlon', 'sughd'] },
        { field: 'amount', op: 'between', value: [10, 100] },
        { field: 'day', op: 'relative', value: { unit: 'month', from: -1, to: -1 } },
        { field: 'comment', op: 'is_empty' },
        { field: 'comment', op: 'neq', value: 'тест' },
      ],
    })
    // Одна мера без разрезов — одно число
    expect(converted.ok && converted.chart).toBe('number')
  })

  it('неизвестное или скрытое поле и мера не того типа — ошибка, план не строится', () => {
    const converted = answerToPlan(
      answer({
        conditions: [{ field: 'phone', op: 'eq', value: '+992', values: null, relative: null }],
        measures: [
          { agg: 'sum', field: 'comment' },
          { agg: 'avg', field: null },
        ],
      }),
      FIELDS,
    )
    expect(converted).toEqual({
      ok: false,
      kind: 'invalid',
      issues: [
        'conditions.0: нет поля «phone»',
        'measures.0: «sum» считается только по числовому полю',
        'measures.1: для «avg» нужно поле',
      ],
    })
  })

  it('исправимое модель не валит: интервал у не-даты, мера без алиаса в сортировке', () => {
    const converted = answerToPlan(
      answer({
        groups: [
          { field: 'district', bucket: 'month' },
          { field: 'day', bucket: 'month' },
        ],
        measures: [{ agg: 'sum', field: 'amount' }],
        sort: { by: 'amount', dir: 'desc' },
        limit: 1_000_000,
        chart: 'number',
      }),
      FIELDS,
    )
    expect(converted.ok && converted.plan).toEqual({
      filter: null,
      groups: [{ field: 'district' }, { field: 'day', bucket: 'month' }],
      measures: [{ agg: 'sum', field: 'amount' }],
      sort: { field: 'sum_amount', dir: 'desc' },
      limit: 50_000,
    })
    // «Одно число» при разрезах невозможно — столбцы
    expect(converted.ok && converted.chart).toBe('bar')
  })

  it('разрез без меры считает строки, неизвестная сортировка отбрасывается', () => {
    const converted = answerToPlan(
      answer({ groups: [{ field: 'district', bucket: null }], sort: { by: 'nope', dir: 'asc' } }),
      FIELDS,
    )
    expect(converted.ok && converted.plan.measures).toEqual([{ agg: 'count' }])
    expect(converted.ok && converted.plan.sort).toBeNull()
  })

  it('без сводки — таблица строк', () => {
    const converted = answerToPlan(answer({ sort: { by: 'day', dir: 'desc' }, limit: 20 }), FIELDS)
    expect(converted.ok && converted.plan.sort).toEqual({ field: 'day', dir: 'desc' })
    expect(converted.ok && converted.chart).toBe('table')
  })

  it('модель не может ответить — причина передаётся пользователю', () => {
    expect(
      answerToPlan(answer({ answerable: false, reason: '  Нет данных о погоде ' }), FIELDS),
    ).toEqual({ ok: false, kind: 'unanswerable', message: 'Нет данных о погоде' })
  })

  it('модели не показываются скрытые, маскированные и неподходящие поля', () => {
    const fields = [...FIELDS, field('phone', 'text'), field('shape', 'geometry')]
    expect(
      askableFields(fields, new Set(['phone']), new Set(['comment'])).map((item) => item.key),
    ).toEqual(['district', 'amount', 'day'])
  })
})
