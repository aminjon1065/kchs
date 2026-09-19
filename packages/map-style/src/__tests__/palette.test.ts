import { describe, expect, it } from 'vitest'
import { styleTileFields } from '../fields.js'
import { deriveOutline, paletteColors, resolveColor } from '../palette.js'
import { style, THEME_DARK, THEME_LIGHT } from './fixtures.js'

/** Светлота OKLab hex-цвета, ×100. */
function lightness(hex: string): number {
  const linear = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const [r, g, b] = linear
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return 100 * (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s)
}

describe('палитры: 3–9 классов из токенов', () => {
  it('7 классов — ровно шаги токенов; края шкалы сохраняются при любом числе классов', () => {
    expect(paletteColors(THEME_LIGHT, 'blue', 7)).toEqual(THEME_LIGHT.sequential.blue)
    for (const n of [3, 4, 5, 6, 8, 9]) {
      const colors = paletteColors(THEME_LIGHT, 'teal', n)
      expect(colors).toHaveLength(n)
      expect(colors[0]).toBe(THEME_LIGHT.sequential.teal[0])
      expect(colors.at(-1)).toBe(THEME_LIGHT.sequential.teal.at(-1))
    }
  })

  it('светлота монотонна: в светлой теме темнеет к большему, в тёмной — светлеет', () => {
    for (const name of ['blue', 'teal', 'orange', 'viridis'] as const) {
      for (const n of [3, 5, 9]) {
        const light = paletteColors(THEME_LIGHT, name, n).map(lightness)
        const dark = paletteColors(THEME_DARK, name, n).map(lightness)
        for (let i = 1; i < n; i += 1) {
          expect(light[i]).toBeLessThan(light[i - 1] as number)
          expect(dark[i]).toBeGreaterThan(dark[i - 1] as number)
        }
      }
    }
  })

  it('расходящиеся: нечётное число классов — нейтраль посередине; reverse меняет полюса', () => {
    expect(paletteColors(THEME_LIGHT, 'brown-teal', 5)[2]).toBe('#F1F1F3')
    expect(paletteColors(THEME_DARK, 'red-blue', 9)[4]).toBe('#25262B')
    const reversed = paletteColors(THEME_LIGHT, { name: 'red-blue', reverse: true }, 3)
    expect(reversed).toEqual(['#2F62E6', '#F1F1F3', '#D63B3B'])
  })

  it('категориальная — по порядку палитры графиков, девятый — «прочее»; status — хорошо → плохо', () => {
    expect(paletteColors(THEME_LIGHT, 'categorical', 9)).toEqual([
      ...THEME_LIGHT.categorical,
      THEME_LIGHT.other,
    ])
    const status = paletteColors(THEME_LIGHT, 'status', 3)
    expect(status).toEqual(['#177E50', '#936500', '#CE2B2B'])
  })
})

describe('цвета стиля', () => {
  it('токены, шаги шкал, семантика и hex; неизвестное — первый цвет палитры', () => {
    expect(resolveColor('categorical.3', THEME_LIGHT)).toEqual({ color: '#D9509C', known: true })
    expect(resolveColor('categorical.10', THEME_LIGHT).color).toBe('#E8842F')
    expect(resolveColor('categorical', THEME_DARK).color).toBe('#2F62E6')
    expect(resolveColor('blue.1', THEME_DARK).color).toBe('#26365C')
    expect(resolveColor('red-blue', THEME_LIGHT).color).toBe('#BCD0F7')
    expect(resolveColor('viridis.99', THEME_LIGHT).color).toBe('#440154')
    expect(resolveColor('status.2', THEME_DARK).color).toBe('#F2B84B')
    expect(resolveColor('danger', THEME_DARK).color).toBe('#F06B6B')
    expect(resolveColor('neutral', THEME_LIGHT).color).toBe('#666875')
    expect(resolveColor('other', THEME_LIGHT).color).toBe('#5B7083')
    expect(resolveColor('#1c9a62', THEME_LIGHT).color).toBe('#1C9A62')
    expect(resolveColor('danger.2', THEME_LIGHT)).toEqual({ color: '#2F62E6', known: false })
  })

  it('«auto»: обводка темнее заливки в светлой теме, светлее — в тёмной', () => {
    const light = deriveOutline('#2F62E6', THEME_LIGHT)
    const dark = deriveOutline('#2F62E6', THEME_DARK)
    expect(lightness(light)).toBeLessThan(lightness('#2F62E6') - 10)
    expect(lightness(dark)).toBeGreaterThan(lightness('#2F62E6') + 10)
  })
})

describe('поля тайла', () => {
  it('поле рендерера, нормализация, размер, подпись и шаблон, время; без point_count', () => {
    expect(
      styleTileFields(
        style({
          geometry: 'point',
          renderer: { kind: 'graduated', field: 'population', normalizeBy: 'area_km2' },
          point: { sizeBy: { field: 'capacity' } },
          label: { template: '{{name}} ({{ capacity }})' },
          time: { field: 'occurred_at' },
          filter: { field: 'kind', op: 'eq', value: 'school' },
        }),
      ),
    ).toEqual(['population', 'area_km2', 'capacity', 'name', 'occurred_at'])
    expect(
      styleTileFields(
        style({
          geometry: 'point',
          renderer: {
            kind: 'rule',
            rules: [
              {
                filter: {
                  or: [
                    { field: 'severity', op: 'gt', value: 3 },
                    { not: { field: 'active', op: 'is_true' } },
                  ],
                },
                color: 'danger',
              },
            ],
          },
          label: { field: 'point_count' },
        }),
      ),
    ).toEqual(['severity', 'active'])
  })
})
