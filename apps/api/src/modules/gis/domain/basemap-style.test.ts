import { readFileSync } from 'node:fs'
import {
  BASEMAP_FONTS,
  BASEMAP_THEMES,
  type BasemapTheme,
  LOCALES,
  type Locale,
} from '@kchs/contracts'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import { MAP_COLORS, TOKEN_COLORS } from './basemap-palette.js'
import { basemapStyle, type StyleContent } from './basemap-style.js'

const ROOT = new URL('../../../../../../', import.meta.url)
const BASE = 'https://kchs.example/api/v1'

const CONTENTS: StyleContent[] = [
  { kind: 'none' },
  {
    kind: 'vector',
    archive: `${BASE}/gis/basemaps/0199a0b0-0000-7000-8000-000000000001/pmtiles/2026-09-19.pmtiles`,
    attribution: '© OpenMapTiles © OpenStreetMap contributors',
    center: [70.5, 39, 5],
  },
  {
    kind: 'raster',
    tiles: `${BASE}/gis/basemaps/0199a0b0-0000-7000-8000-000000000002/tiles/{z}/{x}/{y}?v=abc`,
    tileSize: 256,
    minZoom: 0,
    maxZoom: 19,
    attribution: 'Спутник',
    bounds: null,
  },
]

type Layer = { id: string; type: string; 'source-layer'?: string; layout?: Record<string, unknown> }

function build(content: StyleContent, theme: BasemapTheme = 'light', lang: Locale = 'ru') {
  return basemapStyle({
    id: 'id',
    name: 'Подложка',
    theme,
    lang,
    urls: {
      glyphs: `${BASE}/gis/glyphs/{fontstack}/{range}.pbf`,
      sprite: `${BASE}/gis/sprites/basemap-${theme}`,
    },
    content,
  })
}

/** Все строковые значения выражения/массива (имена шрифтов и значков). */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  return []
}

describe('стиль базовой карты (07-gis-engine.md §5, ADR-0066)', () => {
  for (const content of CONTENTS) {
    for (const theme of BASEMAP_THEMES) {
      for (const lang of LOCALES) {
        it(`${content.kind} / ${theme} / ${lang}: проходит валидатор MapLibre`, () => {
          expect(validateStyleMin(build(content, theme, lang) as never)).toEqual([])
        })
      }
    }
  }

  it('векторная подложка: слои схемы OpenMapTiles сборки, подписи — после заливок', () => {
    const style = build(CONTENTS[1] as StyleContent)
    const layers = style.layers as Layer[]
    // Слои сборки Planetiler (манифест `layers`), которые стиль рисует
    const schema = [
      'boundary',
      'building',
      'landcover',
      'landuse',
      'mountain_peak',
      'park',
      'place',
      'transportation',
      'transportation_name',
      'water',
      'water_name',
      'waterway',
    ]
    for (const layer of layers) {
      if (layer['source-layer']) expect(schema).toContain(layer['source-layer'])
    }
    const firstSymbol = layers.findIndex((layer) => layer.type === 'symbol')
    expect(layers.slice(firstSymbol).every((layer) => layer.type === 'symbol')).toBe(true)
    expect((style.metadata as Record<string, unknown>)['kchs:firstSymbolLayer']).toBe(
      layers[firstSymbol]?.id,
    )
    expect(style.sources).toMatchObject({
      openmaptiles: {
        type: 'vector',
        url: `pmtiles://${(CONTENTS[1] as { archive: string }).archive}`,
      },
    })
  })

  it('подписи — только шрифтами хранилища, значки — только из спрайта сборки', () => {
    const fonts = new Set<string>(Object.values(BASEMAP_FONTS))
    const sprites = readFileSync(new URL('infra/basemaps/sprites.py', ROOT), 'utf8')
    for (const theme of BASEMAP_THEMES) {
      for (const layer of build(CONTENTS[1] as StyleContent, theme).layers as Layer[]) {
        for (const font of strings(layer.layout?.['text-font'])) expect(fonts).toContain(font)
        for (const icon of strings(layer.layout?.['icon-image'])) {
          expect(sprites).toContain(`("${icon}",`)
        }
      }
    }
  })

  it('язык подписей: название на языке интерфейса, затем исходное', () => {
    const place = (lang: Locale) =>
      (build(CONTENTS[1] as StyleContent, 'light', lang).layers as Layer[]).find(
        (layer) => layer.id === 'place-town',
      )?.layout?.['text-field']
    expect(place('ru')).toEqual(['coalesce', ['get', 'name:ru'], ['get', 'name']])
    expect(JSON.stringify(place('tg'))).toContain('name:tg')
    expect(JSON.stringify(place('en'))).toContain('name:en')
  })

  it('без подложки — только фон, но шрифты и спрайт есть для подписей слоёв данных', () => {
    const style = build({ kind: 'none' }, 'dark')
    expect(style.layers).toEqual([
      { id: 'background', type: 'background', paint: { 'background-color': '#0E0F11' } },
    ])
    expect(style.glyphs).toContain('/gis/glyphs/')
    expect(style.sprite).toContain('/gis/sprites/basemap-dark')
  })
})

describe('палитра подложки — из токенов дизайн-системы', () => {
  const tokens = JSON.parse(
    readFileSync(new URL('packages/ui/src/tokens/tokens.json', ROOT), 'utf8'),
  ) as { color: Record<string, Record<string, unknown>> }

  function token(name: string): Record<string, string> {
    for (const group of ['neutral', 'accent', 'semantic'] as const) {
      const value = tokens.color[group]?.[name]
      if (value) return value as Record<string, string>
    }
    throw new Error(`нет токена ${name}`)
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: значения совпадают с tokens.json`, () => {
      for (const [name, hex] of Object.entries(TOKEN_COLORS[theme])) {
        expect(token(name)[theme]?.toUpperCase(), name).toBe(hex)
      }
    })
  }

  it('реки — sequential.blue[1]; цвета значков спрайтов — из токенов', () => {
    const blue = (tokens.color.sequential as Record<string, string[]>).blue
    expect(blue?.[1]).toBe(MAP_COLORS.river)
    const known = new Set<string>(
      Object.values(TOKEN_COLORS).flatMap((theme) => Object.values(theme) as string[]),
    )
    const sprites = readFileSync(new URL('infra/basemaps/sprites.py', ROOT), 'utf8')
    const themes = /THEMES = \{([\s\S]*?)\n\}/.exec(sprites)?.[1] ?? ''
    const colors = [...themes.matchAll(/#[0-9A-F]{6}/g)].map((match) => match[0])
    expect(colors.length).toBeGreaterThan(0)
    for (const color of colors) expect(known).toContain(color)
  })
})
