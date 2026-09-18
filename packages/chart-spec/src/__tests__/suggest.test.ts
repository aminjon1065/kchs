import { describe, expect, it } from 'vitest'
import { chartAltText } from '../alt-text.js'
import { suggestChart } from '../suggest.js'
import { DISTRICTS, MONTHLY, result, SERIES, spec } from './fixtures.js'

const data = { queryId: '01928c4e-7a3b-7c3d-9e4f-0a1b2c3d4e5f' }

describe('умные значения по умолчанию', () => {
  it('одна строка с показателем — «показатель»', () => {
    const one = result([{ name: 'total', type: 'integer', semantic: 'measure' }], [[1284]])
    const s = suggestChart(one, data)
    expect(s.type).toBe('number')
    expect(s.encoding.y[0]?.field).toBe('total')
  })

  it('время и измерение до 8 значений — линия с цветом по измерению', () => {
    const s = suggestChart(MONTHLY, data)
    expect(s.type).toBe('line')
    expect(s.encoding.x).toMatchObject({ field: 'month', type: 'temporal' })
    expect(s.encoding.color).toMatchObject({ field: 'region', type: 'nominal' })
  })

  it('измерение и показатель — столбцы по убыванию', () => {
    const s = suggestChart(DISTRICTS, data)
    expect(s.type).toBe('bar')
    expect(s.encoding.x?.field).toBe('district')
    expect(s.options.sort).toEqual({ by: 'incidents', dir: 'desc' })
    // Ущерб на порядки больше числа происшествий — вторая серия не предлагается
    expect(s.encoding.y).toHaveLength(1)
    // Никогда не две оси
    expect(s.encoding.y.every((y) => y.axis === 'left')).toBe(true)
  })

  it('два числа — точечная, распределение одного числа — гистограмма', () => {
    const pairs = result(
      [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' },
      ],
      [
        [1, 2],
        [3, 4],
      ],
    )
    expect(suggestChart(pairs, data).type).toBe('scatter')
    const many = result(
      [{ name: 'v', type: 'number' }],
      Array.from({ length: 50 }, (_, i) => [i]),
    )
    expect(suggestChart(many, data).type).toBe('histogram')
  })

  it('два измерения с множеством значений — тепловая карта', () => {
    const rows: unknown[][] = []
    for (let a = 0; a < 10; a += 1)
      for (let b = 0; b < 10; b += 1) rows.push([`a${a}`, `b${b}`, a * b])
    const grid = result(
      [
        { name: 'a', type: 'text' },
        { name: 'b', type: 'text' },
        { name: 'v', type: 'integer', semantic: 'measure' },
      ],
      rows,
    )
    const s = suggestChart(grid, data)
    expect(s.type).toBe('heatmap')
    expect(s.encoding.color).toMatchObject({ field: 'v', palette: 'sequential' })
  })

  it('кодировка под выбранный тип', () => {
    const s = suggestChart(DISTRICTS, data, { type: 'pie' })
    expect(s.type).toBe('pie')
    expect(s.encoding.x?.field).toBe('district')
    expect(s.encoding.y[0]?.field).toBe('incidents')
    const combo = suggestChart(DISTRICTS, data, { type: 'combo' })
    expect(combo.encoding.y.map((y) => y.mark)).toEqual(['bar', 'line'])
  })
})

describe('alt-текст', () => {
  it('линия: тип, показатель, ось, серии, диапазон, максимум', () => {
    const text = chartAltText(
      spec({
        type: 'line',
        encoding: {
          x: { field: 'month', type: 'temporal' },
          y: [{ field: 'incidents', type: 'quantitative' }],
          color: { field: 'region', type: 'nominal' },
        },
      }),
      MONTHLY,
      'ru',
    )
    expect(text).toBe(
      'Линейный график: Происшествия по оси «Месяц»; 3 серии по полю «Регион»; 18 значений от 9 до 35; наибольшее — июнь 2026, Хатлон: 35.',
    )
  })

  it('показатель и пустые данные', () => {
    const number = spec({
      type: 'number',
      encoding: {
        x: { field: 'month', type: 'temporal' },
        y: [{ field: 'incidents', type: 'quantitative' }],
      },
    })
    expect(chartAltText(number, SERIES, 'ru')).toBe('Показатель «Происшествия»: 44')
    expect(chartAltText(number, { ...SERIES, rows: [] }, 'en')).toBe('Number: no data')
  })
})
