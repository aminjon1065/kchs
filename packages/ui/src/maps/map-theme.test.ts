import { readFileSync } from 'node:fs'
import { LayerStyle } from '@kchs/contracts'
import { compileLayerStyle } from '@kchs/map-style'
import { afterEach, describe, expect, it, vi } from 'vitest'
import tokens from '../tokens/tokens.json' with { type: 'json' }
import { readMapTheme } from './map-theme.js'

const css = readFileSync(new URL('../tokens/tokens.css', import.meta.url), 'utf8')

/** Переменные блока tokens.css: `:root` — светлая тема, `[data-theme="dark"]` — тёмная. */
function variables(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  const block = css.slice(start, css.indexOf('}', start))
  return new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!]))
}

/** Вычисленный стиль документа в теме: тёмная переопределяет цвета светлой. */
function stubTheme(theme: 'light' | 'dark'): void {
  const values = variables(':root')
  if (theme === 'dark')
    for (const [name, value] of variables('[data-theme="dark"]')) values.set(name, value)
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => values.get(name) ?? '',
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('тема карты из CSS-переменных', () => {
  it('шкалы карт — шаги tokens.json для каждой темы; все цвета — hex', () => {
    for (const theme of ['light', 'dark'] as const) {
      stubTheme(theme)
      const map = readMapTheme({} as HTMLElement)
      expect(map.mode).toBe(theme)
      expect(map.sequential.viridis).toEqual(tokens.color.sequential.viridis[theme])
      expect(map.diverging['brown-teal']).toEqual(tokens.color.diverging['brown-teal'][theme])
      expect(map.categorical).toEqual(tokens.color.viz.categorical[theme])
      const colors = [
        ...map.categorical,
        map.other,
        map.text,
        map.surface,
        ...Object.values(map.sequential).flat(),
        ...Object.values(map.diverging).flat(),
        ...Object.values(map.tokens),
      ]
      for (const color of colors) expect(color).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it('короткая запись и rgb() минифицированного CSS приводятся к #RRGGBB', () => {
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) =>
        name === '--bg-surface' ? '#fff' : name === '--text' ? 'rgb(23, 24, 28)' : '#e9efff',
    }))
    const map = readMapTheme({} as HTMLElement)
    expect(map.mode).toBe('light')
    expect(map.surface).toBe('#FFFFFF')
    expect(map.text).toBe('#17181C')
    expect(map.sequential.blue[0]).toBe('#E9EFFF')
  })

  it('компилятор стиля принимает прочитанную тему', () => {
    stubTheme('dark')
    const compiled = compileLayerStyle(
      LayerStyle.parse({
        version: 1,
        geometry: 'polygon',
        renderer: { kind: 'graduated', field: 'population', palette: { name: 'viridis' } },
      }),
      {
        id: 'districts',
        source: 'districts',
        fields: [{ key: 'population', type: 'integer' }],
        theme: readMapTheme({} as HTMLElement),
        breaks: [0, 10, 100, 1000],
      },
    )
    const swatches = compiled.legend.sections[0]?.items.map((item) =>
      item.swatch.kind === 'fill' ? item.swatch.color : null,
    )
    expect(swatches).toEqual(['#440154', '#21918C', '#FDE725'])
  })
})
