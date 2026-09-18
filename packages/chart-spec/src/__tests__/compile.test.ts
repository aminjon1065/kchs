import { describe, expect, it } from 'vitest'
import { compileChart } from '../compile.js'
import type { CompiledChart } from '../model.js'
import { DISTRICTS, MONTHLY, result, SERIES, spec, THEME } from './fixtures.js'

type Echarts = Extract<CompiledChart, { kind: 'echarts' }>
// biome-ignore lint/suspicious/noExplicitAny: опция ECharts читается в тестах вглубь, без её типов
type AnyRecord = Record<string, any>

function echarts(compiled: CompiledChart): Echarts & { o: AnyRecord } {
  expect(compiled.kind).toBe('echarts')
  const c = compiled as Echarts
  return { ...c, o: c.option as AnyRecord }
}

const byDistrict = (extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  spec({
    type: 'bar',
    encoding: {
      x: { field: 'district', type: 'nominal' },
      y: [{ field: 'incidents', type: 'quantitative' }],
      ...extra,
    },
    options,
  })

/** Все hex-цвета опции — из темы: спецификация и компилятор своих цветов не вводят. */
function colorsFromTheme(option: unknown): void {
  const allowed = new Set(
    [
      ...THEME.categorical,
      ...THEME.sequential,
      ...THEME.diverging,
      ...Object.values(THEME.tokens),
      THEME.other,
      THEME.text,
      THEME.textSecondary,
      THEME.textMuted,
      THEME.textInverse,
      THEME.surface,
      THEME.overlay,
      THEME.grid,
      THEME.axis,
    ].map((c) => c.toUpperCase()),
  )
  const found = JSON.stringify(option).match(/#[0-9a-f]{6}\b/gi) ?? []
  for (const color of found) expect(allowed, color).toContain(color.toUpperCase())
}

describe('столбцы', () => {
  it('сортировка по показателю, скругление конца, подписи при немногих категориях', () => {
    const c = echarts(
      compileChart(byDistrict({}, { sort: { by: 'incidents', dir: 'desc' } }), DISTRICTS, THEME),
    )
    expect(c.o.xAxis.data.slice(0, 3)).toEqual(['Рудаки', 'Вахдат', 'Рашт'])
    const bar = c.o.series[0]
    expect(bar.barMaxWidth).toBe(24)
    expect(bar.data[0].itemStyle.borderRadius).toEqual([4, 4, 0, 0])
    expect(bar.data[0].label.show).toBe(true)
    expect(bar.data[0].label.formatter()).toBe('42')
    expect(c.o.legend).toBeUndefined()
    colorsFromTheme(c.option)
  })

  it('top-N и «Прочее» — сумма остальных, клик по «Прочему» — not_in', () => {
    const c = echarts(compileChart(byDistrict({}, { limit: 3, other: true }), DISTRICTS, THEME))
    expect(c.o.xAxis.data).toEqual(['Рудаки', 'Вахдат', 'Рашт', 'Прочее'])
    const other = c.o.series[0].data[3]
    expect(other.value).toBe(17 + 9 + 5 + 12 + 3 + 7 + 4)
    const pick = c.pick({ seriesIndex: 0, dataIndex: 3 })
    expect(pick?.filters[0]).toEqual({
      field: 'district',
      op: 'not_in',
      value: ['Рудаки', 'Вахдат', 'Рашт'],
    })
    expect(c.pick({ seriesIndex: 0, dataIndex: 0 })?.filters[0]).toEqual({
      field: 'district',
      op: 'eq',
      value: 'Рудаки',
    })
  })

  it('предел без «Прочего» — пометка под графиком', () => {
    const c = echarts(compileChart(byDistrict({}, { limit: 3 }), DISTRICTS, THEME))
    expect(c.o.xAxis.data).toHaveLength(3)
    expect(c.meta.notes).toContain('Показаны 3 из 10 категорий')
  })

  it('горизонтальные: категории на оси Y сверху вниз, скругление справа', () => {
    const c = echarts(compileChart(byDistrict({}, { horizontal: true }), DISTRICTS, THEME))
    expect(c.o.yAxis.type).toBe('category')
    expect(c.o.yAxis.inverse).toBe(true)
    expect(c.o.xAxis[0].type).toBe('value')
    expect(c.o.series[0].data[0].itemStyle.borderRadius).toEqual([0, 4, 4, 0])
  })

  it('стопка: скруглён только верхний сегмент, зазор цвета поверхности', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'bar',
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'incidents', type: 'quantitative' }],
            color: { field: 'region', type: 'nominal' },
          },
          options: { stacked: true },
        }),
        MONTHLY,
        THEME,
      ),
    )
    expect(c.o.series).toHaveLength(3)
    expect(c.o.series.every((s: AnyRecord) => s.stack === 'stack-0')).toBe(true)
    expect(c.o.series[0].data[0].itemStyle.borderRadius).toEqual([0, 0, 0, 0])
    expect(c.o.series[2].data[0].itemStyle.borderRadius).toEqual([4, 4, 0, 0])
    expect(c.o.series[0].itemStyle.borderColor).toBe(THEME.surface)
    expect(c.o.legend).toBeDefined()
    // Период — подписи месяцев, первый с годом
    expect(c.o.xAxis.data[0]).toBe('янв. 2026')
    expect(c.o.xAxis.data[1]).toBe('февр.')
    // Итог стопки — в тултипе
    const tip = c.o.tooltip.formatter({ seriesIndex: 0, dataIndex: 0 })
    expect(tip).toContain('Итого')
    expect(tip).toContain('43')
  })

  it('проценты: доли по категории, ось 0–100 %', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'bar',
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'incidents', type: 'quantitative' }],
            color: { field: 'region', type: 'nominal' },
          },
          options: { percent: true },
        }),
        MONTHLY,
        THEME,
      ),
    )
    const first = c.o.series.map((s: AnyRecord) => s.data[0].value)
    expect(first.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1)
    expect(c.o.yAxis[0].max).toBe(1)
    expect(c.o.yAxis[0].axisLabel.formatter(0.5)).toMatch(/^50\s?%$/)
  })

  it('пропущенный месяц на категориальной оси остаётся пустым местом', () => {
    const gap = result(
      [
        { name: 'month', type: 'date' },
        { name: 'n', type: 'integer' },
      ],
      [
        ['2026-01-01', 5],
        ['2026-03-01', 7],
      ],
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'bar',
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'n', type: 'quantitative' }],
          },
        }),
        gap,
        THEME,
      ),
    )
    expect(c.o.xAxis.data).toHaveLength(3)
    expect(c.o.series[0].data[1]).toBe('-')
  })

  it('больше 8 серий: 7 по величине + «Прочее» серо-синим', () => {
    const rows: unknown[][] = []
    for (let r = 0; r < 12; r += 1)
      rows.push(['2026-01-01', `R${r}`, 10 + r], ['2026-02-01', `R${r}`, 12 + r])
    const many = result(
      [
        { name: 'month', type: 'date' },
        { name: 'region', type: 'text' },
        { name: 'n', type: 'integer' },
      ],
      rows,
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'line',
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'n', type: 'quantitative' }],
            color: { field: 'region', type: 'nominal' },
          },
          options: { other: true },
        }),
        many,
        THEME,
      ),
    )
    expect(c.o.series).toHaveLength(8)
    expect(c.o.series[7].name).toBe('Прочее')
    expect(c.o.series[7].lineStyle.color).toBe(THEME.other)
    // Цвета не повторяются
    const colors = c.o.series.map((s: AnyRecord) => s.lineStyle.color)
    expect(new Set(colors).size).toBe(8)
    expect(c.meta.notes[0]).toContain('Показаны 7 из 12')
  })
})

describe('цвет следует за сущностью', () => {
  it('с доменом фильтр не перекрашивает оставшиеся серии', () => {
    const lineSpec = spec({
      type: 'line',
      encoding: {
        x: { field: 'month', type: 'temporal' },
        y: [{ field: 'incidents', type: 'quantitative' }],
        color: { field: 'region', type: 'nominal' },
      },
    })
    const domain = ['Хатлон', 'Согд', 'РРП']
    const full = echarts(compileChart(lineSpec, MONTHLY, THEME, { colorDomain: domain }))
    const filtered = echarts(
      compileChart(
        lineSpec,
        { ...MONTHLY, rows: MONTHLY.rows.filter((r) => r[1] !== 'Хатлон') },
        THEME,
        { colorDomain: domain },
      ),
    )
    const colorOf = (c: { o: AnyRecord }, name: string) =>
      c.o.series.find((s: AnyRecord) => s.name === name)?.lineStyle.color
    expect(colorOf(filtered, 'Согд')).toBe(colorOf(full, 'Согд'))
    expect(colorOf(filtered, 'РРП')).toBe(THEME.categorical[2])
  })
})

describe('линии и области', () => {
  const monthly = (options: Record<string, unknown> = {}, type = 'line') =>
    spec({
      type,
      encoding: {
        x: { field: 'month', type: 'temporal' },
        y: [{ field: 'incidents', type: 'quantitative' }],
        color: { field: 'region', type: 'nominal' },
      },
      options,
    })

  it('ось времени в UTC, линии 2px со скруглением, подписи концов при ≤4 сериях', () => {
    const c = echarts(compileChart(monthly(), MONTHLY, THEME))
    expect(c.o.useUTC).toBe(true)
    expect(c.o.xAxis.type).toBe('time')
    const line = c.o.series[0]
    expect(line.lineStyle).toMatchObject({ width: 2, cap: 'round', join: 'round' })
    expect(line.symbolSize).toBe(8)
    expect(line.itemStyle.borderColor).toBe(THEME.surface)
    expect(line.endLabel.show).toBe(true)
    expect(line.data[0]).toEqual([Date.parse('2026-01-01T00:00:00Z'), 20])
    expect(c.o.tooltip.trigger).toBe('axis')
    expect(c.o.xAxis.axisLabel.formatter(Date.parse('2026-01-01T00:00:00Z'), 0)).toBe('янв. 2026')
    expect(c.o.xAxis.axisLabel.formatter(Date.parse('2026-03-01T00:00:00Z'), 2)).toBe('март')
  })

  it('область — заливка 10 %, в стопке — 30 %', () => {
    const plain = echarts(compileChart(monthly({}, 'area'), MONTHLY, THEME))
    expect(plain.o.series[0].areaStyle.opacity).toBe(0.1)
    const stacked = echarts(compileChart(monthly({ stacked: true }, 'area'), MONTHLY, THEME))
    expect(stacked.o.series[0].areaStyle.opacity).toBe(0.3)
    expect(stacked.o.series[0].stack).toBe('stack-0')
  })

  it('опорная линия и аннотация — подписи текстовым цветом, линия — токеном', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'line',
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'incidents', type: 'quantitative' }],
          },
          options: {
            referenceLines: [{ axis: 'y', value: 30, label: 'Порог {x}' }],
            annotations: [{ x: '2026-04-01', text: 'Начало паводка' }],
          },
        }),
        SERIES,
        THEME,
      ),
    )
    const mark = c.o.series[0].markLine
    expect(mark.data[0].yAxis).toBe(30)
    expect(mark.data[0].lineStyle).toMatchObject({ color: THEME.tokens.danger, type: 'dashed' })
    expect(mark.data[0].label.color).toBe(THEME.textSecondary)
    expect(mark.data[0].label.formatter()).toBe('Порог {x}')
    expect(mark.data[1].xAxis).toBe(Date.parse('2026-04-01T00:00:00Z'))
    expect(mark.data[1].label.formatter()).toBe('Начало паводка')
  })

  it('сравнение с прошлым периодом — пунктирная серия со сдвигом на период', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'line',
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'incidents', type: 'quantitative' }],
          },
          options: { comparison: { mode: 'previous_period' } },
        }),
        SERIES,
        THEME,
      ),
    )
    expect(c.o.series).toHaveLength(2)
    const ghost = c.o.series[0]
    expect(ghost.lineStyle.type).toBe('dashed')
    expect(ghost.name).toBe('Происшествия, прошлый период')
    // Февраль сравнивается с январём (31), январю сравнивать не с чем
    expect(ghost.data[0]).toEqual([Date.parse('2026-02-01T00:00:00Z'), 31])
    expect(c.pick({ seriesIndex: 0, dataIndex: 0 })).toBeNull()
  })

  it('цель — пунктирная опорная линия', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'line',
          encoding: {
            x: { field: 'month', type: 'temporal' },
            y: [{ field: 'incidents', type: 'quantitative' }],
          },
          options: { comparison: { mode: 'target' }, target: 40 },
        }),
        SERIES,
        THEME,
      ),
    )
    expect(c.o.series[0].markLine.data[0]).toMatchObject({ yAxis: 40 })
  })

  it('больше 5000 точек — LTTB и пометка', () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => [
      new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      Math.sin(i / 100) * 10,
    ])
    const big = result(
      [
        { name: 'at', type: 'datetime' },
        { name: 'v', type: 'number' },
      ],
      rows,
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'line',
          encoding: {
            x: { field: 'at', type: 'temporal' },
            y: [{ field: 'v', type: 'quantitative' }],
          },
        }),
        big,
        THEME,
        { timezone: 'UTC' },
      ),
    )
    expect(c.o.series[0].data).toHaveLength(5000)
    expect(c.meta.notes).toContain('Линии упрощены до 5000 точек из 12000')
  })

  it('кисть по времени — диапазон исходных значений', () => {
    const c = echarts(compileChart(monthly({ brush: true }), MONTHLY, THEME))
    expect(c.o.brush.brushType).toBe('lineX')
    const filter = c.brush([{ seriesIndex: 0, dataIndex: [1, 2, 3] }])
    expect(filter).toEqual({ field: 'month', op: 'between', value: ['2026-02-01', '2026-04-01'] })
  })
})

describe('комбинированный', () => {
  it('две оси подписаны именами своих серий', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'combo',
          encoding: {
            x: { field: 'district', type: 'nominal' },
            y: [
              { field: 'incidents', type: 'quantitative', mark: 'bar' },
              { field: 'damage', type: 'quantitative', mark: 'line', axis: 'right' },
            ],
          },
        }),
        DISTRICTS,
        THEME,
      ),
    )
    expect(c.o.yAxis).toHaveLength(2)
    expect(c.o.yAxis[0].name).toBe('Происшествия')
    expect(c.o.yAxis[1].name).toBe('Ущерб')
    expect(c.o.yAxis[1].position).toBe('right')
    expect(c.o.series[0].type).toBe('bar')
    expect(c.o.series[1].type).toBe('line')
    expect(c.o.series[1].yAxisIndex).toBe(1)
    colorsFromTheme(c.option)
  })
})

describe('доли целого', () => {
  it('круговая: по убыванию, не больше 8 долей, остальное — «Прочее»', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'pie',
          encoding: {
            x: { field: 'district', type: 'nominal' },
            y: [{ field: 'incidents', type: 'quantitative' }],
          },
        }),
        DISTRICTS,
        THEME,
      ),
    )
    const data = c.o.series[0].data
    expect(data).toHaveLength(8)
    expect(data[0].name).toBe('Рудаки')
    expect(data[7]).toMatchObject({
      name: 'Прочее',
      value: 4 + 3 + 5,
      itemStyle: { color: THEME.other },
    })
    expect(c.o.series[0].itemStyle).toMatchObject({ borderColor: THEME.surface, borderWidth: 2 })
    expect(c.table.columns.map((col) => col.label)).toEqual(['Район', 'Происшествия', 'Доля'])
  })

  it('кольцевая: итог в центре', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'donut',
          encoding: {
            x: { field: 'district', type: 'nominal' },
            y: [{ field: 'incidents', type: 'quantitative' }],
          },
          options: { limit: 4, other: true },
        }),
        DISTRICTS,
        THEME,
      ),
    )
    expect(c.o.series[0].radius).toEqual(['50%', '72%'])
    expect(c.o.title.text).toBe('148')
  })

  it('воронка — порядок этапов из данных, один оттенок, конверсия в подписи', () => {
    const funnel = result(
      [
        { name: 'stage', type: 'text' },
        { name: 'n', type: 'integer' },
      ],
      [
        ['Заявки', 200],
        ['Проверены', 150],
        ['Выезд', 60],
      ],
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'funnel',
          encoding: {
            x: { field: 'stage', type: 'nominal' },
            y: [{ field: 'n', type: 'quantitative' }],
          },
        }),
        funnel,
        THEME,
      ),
    )
    expect(c.o.series[0].sort).toBe('none')
    expect(c.o.series[0].itemStyle.color).toBe(THEME.categorical[0])
    expect(c.o.series[0].label.formatter({ dataIndex: 2 })).toMatch(/^Выезд: 60 · 30,0\s?%$/)
  })

  it('древовидная карта с группами — оттенок группы, текст контрастен заливке', () => {
    const tree = result(
      [
        { name: 'region', type: 'text' },
        { name: 'district', type: 'text' },
        { name: 'n', type: 'integer' },
      ],
      [
        ['Хатлон', 'Бохтар', 30],
        ['Хатлон', 'Кулоб', 20],
        ['Согд', 'Худжанд', 25],
      ],
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'treemap',
          encoding: {
            x: { field: 'district', type: 'nominal' },
            y: [{ field: 'n', type: 'quantitative' }],
            color: { field: 'region', type: 'nominal' },
          },
        }),
        tree,
        THEME,
      ),
    )
    const nodes = c.o.series[0].data
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({
      name: 'Хатлон',
      value: 50,
      itemStyle: { color: THEME.categorical[0] },
    })
    expect(nodes[0].children).toHaveLength(2)
    expect(nodes[0].label.color).toBe(THEME.textInverse)
    expect(c.pick({ data: nodes[0] })?.filters[0]).toEqual({
      field: 'region',
      op: 'eq',
      value: 'Хатлон',
    })
  })
})

describe('точки, матрица, распределение, шкала', () => {
  it('точечная: не больше трёх групп + «Прочее», кольцо поверхности', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [i, i * 2, `G${i % 5}`])
    const data = result(
      [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' },
        { name: 'g', type: 'text' },
      ],
      rows,
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'scatter',
          encoding: {
            x: { field: 'a', type: 'quantitative' },
            y: [{ field: 'b', type: 'quantitative' }],
            color: { field: 'g', type: 'nominal' },
          },
        }),
        data,
        THEME,
      ),
    )
    expect(c.o.series).toHaveLength(4)
    expect(c.o.series[3].name).toBe('Прочее')
    expect(c.o.series[0].itemStyle.borderColor).toBe(THEME.surface)
    expect(c.o.series[0].symbolSize).toBe(8)
  })

  it('пузырьковая: площадь пропорциональна размеру', () => {
    const data = result(
      [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' },
        { name: 's', type: 'number' },
      ],
      [
        [1, 1, 0],
        [2, 2, 100],
      ],
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'bubble',
          encoding: {
            x: { field: 'a', type: 'quantitative' },
            y: [{ field: 'b', type: 'quantitative' }],
            size: { field: 's', type: 'quantitative' },
          },
        }),
        data,
        THEME,
      ),
    )
    const size = c.o.series[0].symbolSize
    expect(size([0, 0, 0])).toBe(6)
    expect(size([0, 0, 100])).toBe(36)
  })

  it('тепловая карта: расходящаяся шкала при значениях по обе стороны нуля', () => {
    const data = result(
      [
        { name: 'x', type: 'text' },
        { name: 'y', type: 'text' },
        { name: 'v', type: 'number' },
      ],
      [
        ['a', 'p', -5],
        ['b', 'p', 10],
        ['a', 'q', 3],
      ],
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'heatmap',
          encoding: {
            x: { field: 'x', type: 'nominal' },
            y: [{ field: 'y', type: 'nominal' }],
            color: { field: 'v', type: 'quantitative' },
          },
        }),
        data,
        THEME,
      ),
    )
    expect(c.o.visualMap.min).toBe(-10)
    expect(c.o.visualMap.max).toBe(10)
    expect(c.o.visualMap.inRange.color).toEqual([...THEME.diverging])
    expect(c.o.series[0].itemStyle).toMatchObject({ borderColor: THEME.surface, borderWidth: 2 })
    expect(c.o.series[0].data).toHaveLength(3)
  })

  it('гистограмма: корзины на клиенте, клик — диапазон', () => {
    const data = result(
      [{ name: 'v', type: 'number' }],
      Array.from({ length: 100 }, (_, i) => [i]),
    )
    const c = echarts(
      compileChart(
        spec({ type: 'histogram', encoding: { x: { field: 'v', type: 'quantitative' } } }),
        data,
        THEME,
      ),
    )
    const counts: number[] = c.o.series[0].data
    expect(counts.reduce((a, b) => a + b, 0)).toBe(100)
    expect(c.pick({ seriesIndex: 0, dataIndex: 0 })?.filters[0]?.op).toBe('between')
    expect(c.table.columns[1]?.label).toBe('Количество')
  })

  it('шкала: пороги — полосы цветов порогов и стрелка', () => {
    const c = echarts(
      compileChart(
        spec({
          type: 'gauge',
          encoding: { y: [{ field: 'incidents', type: 'quantitative' }] },
          options: {
            thresholds: [
              { value: 20, color: 'warning' },
              { value: 40, color: 'danger' },
            ],
            axes: { y: { max: 50 } },
          },
        }),
        DISTRICTS,
        THEME,
      ),
    )
    const gauge = c.o.series[0]
    expect(gauge.axisLine.lineStyle.color).toEqual([
      [0.4, THEME.grid],
      [0.8, THEME.tokens.warning],
      [1, THEME.tokens.danger],
    ])
    expect(gauge.pointer.show).toBe(true)
    expect(gauge.data[0].value).toBe(42)
  })
})

describe('показатель и таблица', () => {
  it('показатель: последнее значение, дельта к прошлому периоду, искра, цель', () => {
    const c = compileChart(
      spec({
        type: 'number',
        encoding: {
          x: { field: 'month', type: 'temporal' },
          y: [{ field: 'incidents', type: 'quantitative' }],
        },
        options: { comparison: { mode: 'previous_period' }, target: 50 },
      }),
      SERIES,
      THEME,
    )
    expect(c.kind).toBe('number')
    if (c.kind !== 'number') return
    expect(c.model.value).toBe(44)
    expect(c.model.delta).toMatchObject({
      direction: 'up',
      good: true,
      label: 'к прошлому периоду',
    })
    expect(c.model.delta?.formatted).toMatch(/^\+15,8\s?%$/)
    expect(c.model.spark).toEqual([31, 28, 35, 40, 38, 44])
    expect(c.model.target?.progress).toBeCloseTo(0.88)
    expect(c.table.rows[0]).toEqual(['янв. 2026', '31'])
  })

  it('рост «хуже» при направлении lower_better, порог по значению', () => {
    const c = compileChart(
      spec({
        type: 'number',
        encoding: {
          x: { field: 'month', type: 'temporal' },
          y: [{ field: 'incidents', type: 'quantitative' }],
        },
        options: {
          comparison: { mode: 'previous_period' },
          thresholds: [
            { value: 30, color: 'warning' },
            { value: 42, color: 'danger' },
          ],
        },
      }),
      SERIES,
      THEME,
      { direction: 'lower_better' },
    )
    if (c.kind !== 'number') throw new Error(c.kind)
    expect(c.model.delta?.good).toBe(false)
    expect(c.model.status).toBe('danger')
  })

  it('большое значение показателя — компактно', () => {
    const c = compileChart(
      spec({ type: 'number', encoding: { y: [{ field: 'v', type: 'quantitative' }] } }),
      result([{ name: 'v', type: 'number' }], [[4_200_000]]),
      THEME,
    )
    if (c.kind !== 'number') throw new Error(c.kind)
    expect(c.model.formatted).toMatch(/^4,2\smлн$|^4,2\sмлн$/)
  })

  it('таблица: столбцы кодировки, числа форматируются', () => {
    const c = compileChart(
      spec({
        type: 'table',
        encoding: {
          x: { field: 'district', type: 'nominal' },
          y: [{ field: 'damage', type: 'quantitative', format: { precision: 1 } }],
        },
      }),
      DISTRICTS,
      THEME,
    )
    if (c.kind !== 'table') throw new Error(c.kind)
    expect(c.table.columns).toEqual([
      { key: 'district', label: 'Район', numeric: false },
      { key: 'damage', label: 'Ущерб', numeric: true },
    ])
    expect(c.table.rows[1]?.[1]).toMatch(/^5.870,0$/)
  })
})

describe('состояния и безопасность', () => {
  it('карта — заглушка фазы 2 с таблицей данных', () => {
    const c = compileChart(spec({ type: 'map', encoding: {} }), DISTRICTS, THEME)
    expect(c.kind).toBe('unsupported')
    if (c.kind === 'unsupported') expect(c.table?.rows).toHaveLength(10)
  })

  it('поле, которого нет в результате, — понятная ошибка с путём', () => {
    const c = compileChart(
      byDistrict({ y: [{ field: 'nope', type: 'quantitative' }] }),
      DISTRICTS,
      THEME,
    )
    expect(c.kind).toBe('invalid')
    if (c.kind === 'invalid') {
      expect(c.issues[0]).toEqual({
        path: ['encoding', 'y', 0, 'field'],
        message: 'В результате запроса нет поля «nope»',
      })
    }
  })

  it('текстовое поле показателем — ошибка «должно быть числовым»', () => {
    const c = compileChart(
      byDistrict({ y: [{ field: 'district', type: 'quantitative' }] }),
      DISTRICTS,
      THEME,
    )
    expect(c.kind).toBe('invalid')
  })

  it('пустой результат — состояние «нет данных»', () => {
    const c = compileChart(byDistrict(), { ...DISTRICTS, rows: [] }, THEME)
    expect(c).toMatchObject({ kind: 'empty', message: 'Нет данных для графика' })
  })

  it('подписи в тултипе экранируются, стилей в разметке нет (CSP)', () => {
    const evil = result(
      [
        { name: 'name', type: 'text' },
        { name: 'n', type: 'integer' },
      ],
      [['<img src=x onerror=alert(1)>', 5]],
    )
    const c = echarts(
      compileChart(
        spec({
          type: 'bar',
          encoding: {
            x: { field: 'name', type: 'nominal' },
            y: [{ field: 'n', type: 'quantitative' }],
          },
        }),
        evil,
        THEME,
      ),
    )
    const html: string = c.o.tooltip.formatter({ seriesIndex: 0, dataIndex: 0 })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toMatch(/style=/)
    expect(c.o.tooltip.confine).toBe(true)
  })

  it('английский язык: подписи и форматы', () => {
    const c = echarts(
      compileChart(byDistrict({}, { limit: 2, other: true }), DISTRICTS, THEME, { locale: 'en' }),
    )
    expect(c.o.xAxis.data.at(-1)).toBe('Other')
    expect(c.alt.startsWith('Bar chart: Происшествия')).toBe(true)
  })
})
