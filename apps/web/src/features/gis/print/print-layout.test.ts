import type { LegendModel } from '@kchs/map-style'
import { describe, expect, it } from 'vitest'
import {
  flowLegend,
  LEGEND_ROW_HEIGHT,
  type LegendRow,
  legendRows,
  paperPoints,
  printFileName,
  printLayout,
  type Rect,
  scaleBar,
} from './print-layout.js'

const point = (color: string) =>
  ({
    kind: 'point',
    shape: 'circle',
    color,
    outline: '#000000',
    size: 8,
    opacity: 1,
    icon: null,
  }) as const

const legend = (items: number, extra: Partial<LegendModel> = {}): LegendModel => ({
  show: true,
  title: null,
  sections: [
    {
      id: 'main',
      title: null,
      items: Array.from({ length: items }, (_, index) => ({
        id: `i${index}`,
        label: `Класс ${index + 1}`,
        swatch: point('#2F62E6'),
      })),
    },
  ],
  note: null,
  ...extra,
})

const inside = (inner: Rect, outer: { width: number; height: number }, margin: number) =>
  inner.x >= margin - 1e-6 &&
  inner.y >= margin - 1e-6 &&
  inner.x + inner.w <= outer.width - margin + 1e-6 &&
  inner.y + inner.h <= outer.height - margin + 1e-6

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('макет печати: лист', () => {
  it('A4 и A3 при 150 dpi, пункты PDF', () => {
    const a4 = printLayout({
      options: { format: 'a4', orientation: 'portrait', title: 'Карта', legend: false },
      view: { width: 800, height: 600 },
      rows: [],
    })
    expect(a4.page).toEqual({ width: 1240, height: 1754 })
    expect(a4.unit).toBeCloseTo(1.5625)
    const a3 = printLayout({
      options: { format: 'a3', orientation: 'landscape', title: 'Карта', legend: false },
      view: { width: 800, height: 600 },
      rows: [],
    })
    expect(a3.page).toEqual({ width: 2480, height: 1754 })
    const [w, h] = paperPoints('a4', 'landscape')
    expect(w).toBeCloseTo(841.89, 1)
    expect(h).toBeCloseTo(595.28, 1)
  })

  it('альбомный лист: легенда справа, блоки внутри полей и не пересекаются', () => {
    const rows = legendRows([{ name: 'Объекты', legend: legend(4) }])
    const layout = printLayout({
      options: { format: 'a4', orientation: 'landscape', title: 'Обстановка', legend: true },
      view: { width: 800, height: 600 },
      rows,
    })
    const { header, map, legend: side, footer, logical, margin } = layout
    expect(header).not.toBeNull()
    expect(side).not.toBeNull()
    for (const rect of [header as Rect, map, side as Rect, footer]) {
      expect(inside(rect, logical, margin)).toBe(true)
    }
    expect(overlap(map, side as Rect)).toBe(false)
    expect(overlap(map, footer)).toBe(false)
    expect(overlap(map, header as Rect)).toBe(false)
    expect((side as Rect).x).toBeGreaterThan(map.x + map.w)
  })

  it('книжный лист: полоса легенды под картой — ровно по строкам, не выше трети', () => {
    const rows = legendRows([{ name: 'Объекты', legend: legend(6) }])
    const layout = printLayout({
      options: { format: 'a4', orientation: 'portrait', title: '', legend: true },
      view: { width: 800, height: 600 },
      rows,
    })
    const band = layout.legend as Rect
    expect(layout.header).toBeNull()
    expect(band.y).toBeGreaterThan(layout.map.y + layout.map.h)
    expect(flowLegend(rows, band, 180).hidden).toBe(0)
    // Высота — по самой длинной колонке, а не по сумме строк
    const total = rows.reduce((sum, row) => sum + LEGEND_ROW_HEIGHT[row.kind], 0)
    expect(band.h).toBeLessThan(total)
    const many = legendRows([{ name: 'Много', legend: legend(400) }])
    const capped = printLayout({
      options: { format: 'a4', orientation: 'portrait', title: '', legend: true },
      view: { width: 800, height: 600 },
      rows: many,
    })
    expect((capped.legend as Rect).h).toBeLessThanOrEqual(capped.logical.height * 0.32)
    expect(flowLegend(many, capped.legend as Rect, 180).hidden).toBeGreaterThan(0)
  })

  it('текущий вид: карта размером с экранную, лист вокруг неё, ×2', () => {
    const layout = printLayout({
      options: { format: 'view', orientation: 'landscape', title: 'Вид', legend: true },
      view: { width: 900, height: 500 },
      rows: legendRows([{ name: 'Слой', legend: legend(2) }]),
    })
    expect(layout.map.w).toBe(900)
    expect(layout.map.h).toBe(500)
    expect(layout.unit).toBe(2)
    expect(layout.logical.width).toBe(16 + 900 + 12 + 220 + 16)
    expect(layout.page.width).toBe(Math.round(layout.logical.width * 2))
    const narrow = printLayout({
      options: { format: 'view', orientation: 'landscape', title: 'Вид', legend: true },
      view: { width: 420, height: 500 },
      rows: legendRows([{ name: 'Слой', legend: legend(2) }]),
    })
    expect((narrow.legend as Rect).y).toBeGreaterThan(narrow.map.y + narrow.map.h)
  })
})

describe('макет печати: легенда, масштаб, имя файла', () => {
  it('строки легенды: слой, заголовок стиля, части, пояснение; скрытая — без строк', () => {
    const rows = legendRows([
      {
        name: 'Происшествия',
        legend: legend(2, { title: 'Вид', note: 'Классы появятся позже' }),
      },
      { name: 'Скрытый', legend: legend(3, { show: false }) },
    ])
    expect(rows.map((row) => row.kind)).toEqual(['layer', 'section', 'item', 'item', 'note'])
    // Простой стиль: образец подписан названием слоя — без отдельной строки слоя
    const simple = legend(1)
    const item = simple.sections[0]?.items[0]
    if (item) item.label = 'Школы'
    expect(legendRows([{ name: 'Школы', legend: simple }]).map((row) => row.kind)).toEqual(['item'])
  })

  it('перенос по колонкам: название слоя не остаётся без строки под ним', () => {
    const rows: LegendRow[] = [
      { kind: 'item', text: 'a', swatch: point('#000000') },
      { kind: 'layer', text: 'Второй' },
      { kind: 'item', text: 'b', swatch: point('#000000') },
    ]
    // В колонку входят две строки: название второго слоя уходит в следующую колонку
    // (колонки растянуты на всю ширину: (380 − 12) / 2 = 184)
    const flow = flowLegend(rows, { x: 0, y: 0, w: 380, h: 40 }, 180)
    expect(flow.columns).toBe(2)
    expect(flow.hidden).toBe(0)
    expect(flow.placed.map((item) => [item.row.kind, item.x, item.y])).toEqual([
      ['item', 0, 0],
      ['layer', 196, 0],
      ['item', 196, 22],
    ])
    const cut = flowLegend(rows, { x: 0, y: 0, w: 180, h: 40 }, 180)
    expect(cut.hidden).toBe(2)
  })

  it('линейка: 1, 2, 5 × 10ⁿ в пределах ширины', () => {
    expect(scaleBar(10, 120)).toEqual({ meters: 1000, width: 100 })
    expect(scaleBar(3, 120)).toEqual({ meters: 200, width: 200 / 3 })
    expect(scaleBar(0.04, 120)?.meters).toBe(2)
    expect(scaleBar(0, 120)).toBeNull()
  })

  it('имя файла — заголовок без запрещённых символов', () => {
    expect(printFileName('Обстановка: март/апрель', 'pdf')).toBe('Обстановка март апрель.pdf')
    expect(printFileName('  ', 'png')).toBe('map.png')
  })
})
