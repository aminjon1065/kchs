import { describe, expect, it } from 'vitest'
import { rebaseApiUrls } from './report-map.js'

describe('rebaseApiUrls', () => {
  it('адреса API стиля подложки — к origin страницы печати, остальное без изменений', () => {
    const style = {
      version: 8,
      glyphs: 'http://localhost:5173/api/v1/gis/basemaps/fonts/{fontstack}/{range}.pbf',
      sprite: 'https://kchs.example.org/api/v1/gis/basemaps/sprite',
      sources: {
        base: {
          type: 'vector',
          url: 'pmtiles://http://localhost:5173/api/v1/gis/basemaps/b1/pmtiles/tj.pmtiles',
          attribution: '© OpenStreetMap',
        },
        raster: {
          type: 'raster',
          tiles: ['http://localhost:5173/api/v1/gis/basemaps/b2/tiles/{z}/{x}/{y}?v=1'],
        },
        external: { type: 'raster', tiles: ['https://tile.example.org/{z}/{x}/{y}.png'] },
      },
      layers: [{ id: 'water', paint: { 'fill-color': '#abc' } }],
    }
    const rebased = rebaseApiUrls(style, 'http://web')
    expect(rebased.glyphs).toBe('http://web/api/v1/gis/basemaps/fonts/{fontstack}/{range}.pbf')
    expect(rebased.sprite).toBe('http://web/api/v1/gis/basemaps/sprite')
    expect(rebased.sources.base.url).toBe(
      'pmtiles://http://web/api/v1/gis/basemaps/b1/pmtiles/tj.pmtiles',
    )
    expect(rebased.sources.raster.tiles).toEqual([
      'http://web/api/v1/gis/basemaps/b2/tiles/{z}/{x}/{y}?v=1',
    ])
    // Чужие адреса и прочие значения не трогаются
    expect(rebased.sources.external.tiles).toEqual(['https://tile.example.org/{z}/{x}/{y}.png'])
    expect(rebased.sources.base.attribution).toBe('© OpenStreetMap')
    expect(rebased.layers).toEqual(style.layers)
    expect(rebased.version).toBe(8)
  })
})
